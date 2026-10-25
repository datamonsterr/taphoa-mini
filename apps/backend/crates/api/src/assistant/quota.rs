//! Daily message cap per store, and the "OpenRouter free quota is spent" flag.
//!
//! Counters live in Redis; without Redis (unit tests, local runs) a process-local map stands in,
//! like the rate limiter's memory fallback.
use crate::{ApiError, AppState};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use redis::aio::ConnectionManager;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex, MutexGuard, PoisonError},
};
use uuid::Uuid;

/// A counter outlives its business date, so a late request never meets a fresh counter.
const QUOTA_TTL_SECS: i64 = 172_800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaOutcome {
    /// The message counts; `used` includes it.
    Allowed {
        used: u32,
    },
    Exceeded,
}

/// Counts one user message for the store and business date against `cap`.
pub async fn take_message(
    state: &AppState,
    store_id: Uuid,
    business_date: NaiveDate,
    cap: u32,
) -> Result<QuotaOutcome, ApiError> {
    let key = format!("assistant:quota:{store_id}:{business_date}");
    let used = incr(state, &key, QUOTA_TTL_SECS, Utc::now())
        .await
        .map_err(|error| {
            tracing::error!(%error, "assistant quota counter failed");
            ApiError::unavailable()
        })?;
    Ok(match u32::try_from(used) {
        Ok(used) if used <= cap => QuotaOutcome::Allowed { used },
        _ => QuotaOutcome::Exceeded,
    })
}

/// True while a free-model daily limit response is remembered for the current UTC day.
/// A Redis failure reads as "not exhausted": the next model call finds out for itself.
pub async fn openrouter_exhausted(state: &AppState) -> bool {
    exhausted_at(state, Utc::now()).await
}
/// Remember that OpenRouter's free daily limit is spent, until the next UTC midnight.
pub async fn mark_openrouter_exhausted(state: &AppState) {
    mark_exhausted_at(state, Utc::now()).await;
}
/// Forget the flag (tests and operators).
pub async fn clear_openrouter_exhausted(state: &AppState) {
    clear_exhausted_at(state, Utc::now()).await;
}

fn flag_key(now: DateTime<Utc>) -> String {
    format!("assistant:openrouter_exhausted:{}", now.date_naive())
}
fn next_utc_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    (now.date_naive() + Duration::days(1))
        .and_time(chrono::NaiveTime::MIN)
        .and_utc()
}
async fn exhausted_at(state: &AppState, now: DateTime<Utc>) -> bool {
    let key = flag_key(now);
    let Some(connection) = &state.redis else {
        return MEMORY.exists(&key, now);
    };
    match redis::cmd("EXISTS")
        .arg(&key)
        .query_async::<i64>(&mut connection.clone())
        .await
    {
        Ok(found) => found > 0,
        Err(error) => {
            tracing::warn!(%error, "assistant exhausted flag unreadable");
            false
        }
    }
}
async fn mark_exhausted_at(state: &AppState, now: DateTime<Utc>) {
    let key = flag_key(now);
    let seconds = (next_utc_midnight(now) - now).num_seconds().max(1);
    let Some(connection) = &state.redis else {
        return MEMORY.set(&key, now + Duration::seconds(seconds));
    };
    if let Err(error) = redis::cmd("SET")
        .arg(&key)
        .arg(1)
        .arg("EX")
        .arg(seconds)
        .query_async::<()>(&mut connection.clone())
        .await
    {
        tracing::error!(%error, "assistant exhausted flag not stored");
    }
}
async fn clear_exhausted_at(state: &AppState, now: DateTime<Utc>) {
    let key = flag_key(now);
    let Some(connection) = &state.redis else {
        return MEMORY.clear(&key);
    };
    if let Err(error) = redis::cmd("DEL")
        .arg(&key)
        .query_async::<i64>(&mut connection.clone())
        .await
    {
        tracing::error!(%error, "assistant exhausted flag not cleared");
    }
}

async fn incr(
    state: &AppState,
    key: &str,
    ttl_secs: i64,
    now: DateTime<Utc>,
) -> anyhow::Result<u64> {
    let Some(connection) = &state.redis else {
        return Ok(MEMORY.incr(key, ttl_secs, now));
    };
    redis_incr(connection, key, ttl_secs).await
}
async fn redis_incr(
    connection: &ConnectionManager,
    key: &str,
    ttl_secs: i64,
) -> anyhow::Result<u64> {
    // One script: the expiry is set together with the first increment, never separately.
    let script = redis::Script::new(
        "local n = redis.call('INCR', KEYS[1]); \
         if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n",
    );
    Ok(script
        .key(key)
        .arg(ttl_secs)
        .invoke_async(&mut connection.clone())
        .await?)
}

/// Process-local counters and flags with an expiry, for runs without Redis.
#[derive(Default)]
struct Memory {
    entries: Mutex<HashMap<String, (u64, DateTime<Utc>)>>,
}
static MEMORY: LazyLock<Memory> = LazyLock::new(Memory::default);
impl Memory {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, (u64, DateTime<Utc>)>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn incr(&self, key: &str, ttl_secs: i64, now: DateTime<Utc>) -> u64 {
        let mut entries = self.entries();
        entries.retain(|_, (_, expires)| *expires > now);
        let entry = entries
            .entry(key.to_owned())
            .or_insert((0, now + Duration::seconds(ttl_secs)));
        entry.0 += 1;
        entry.0
    }
    fn exists(&self, key: &str, now: DateTime<Utc>) -> bool {
        self.entries()
            .get(key)
            .is_some_and(|(_, expires)| *expires > now)
    }
    fn set(&self, key: &str, expires: DateTime<Utc>) {
        self.entries().insert(key.to_owned(), (1, expires));
    }
    fn clear(&self, key: &str) {
        self.entries().remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }
    fn date(text: &str) -> NaiveDate {
        text.parse().unwrap()
    }

    #[tokio::test]
    async fn counts_up_to_the_cap_then_refuses() {
        let state = AppState::default();
        let store = Uuid::new_v4();
        let day = date("2026-10-25");
        for used in 1..=3 {
            assert_eq!(
                take_message(&state, store, day, 3).await.unwrap(),
                QuotaOutcome::Allowed { used }
            );
        }
        for _ in 0..2 {
            assert_eq!(
                take_message(&state, store, day, 3).await.unwrap(),
                QuotaOutcome::Exceeded
            );
        }
    }

    #[tokio::test]
    async fn stores_and_business_dates_count_separately() {
        let state = AppState::default();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let day = date("2026-10-25");
        assert_eq!(
            take_message(&state, a, day, 1).await.unwrap(),
            QuotaOutcome::Allowed { used: 1 }
        );
        assert_eq!(
            take_message(&state, a, day, 1).await.unwrap(),
            QuotaOutcome::Exceeded
        );
        assert_eq!(
            take_message(&state, b, day, 1).await.unwrap(),
            QuotaOutcome::Allowed { used: 1 }
        );
        assert_eq!(
            take_message(&state, a, date("2026-10-26"), 1)
                .await
                .unwrap(),
            QuotaOutcome::Allowed { used: 1 }
        );
    }

    #[tokio::test]
    async fn concurrent_messages_never_exceed_the_cap() {
        let state = AppState::default();
        let store = Uuid::new_v4();
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let state = state.clone();
            tasks.push(tokio::spawn(async move {
                take_message(&state, store, date("2026-10-25"), 5).await
            }));
        }
        let mut allowed = 0;
        for task in tasks {
            allowed += usize::from(matches!(
                task.await.unwrap().unwrap(),
                QuotaOutcome::Allowed { .. }
            ));
        }
        assert_eq!(allowed, 5);
    }

    #[test]
    fn memory_entries_expire() {
        let memory = Memory::default();
        let start = at("2026-10-25T00:00:00Z");
        assert_eq!(memory.incr("k", 60, start), 1);
        assert_eq!(memory.incr("k", 60, start + Duration::seconds(59)), 2);
        // The expiry is fixed by the first increment, like Redis EXPIRE on count 1.
        assert_eq!(memory.incr("k", 60, start + Duration::seconds(61)), 1);
        assert!(!memory.exists("flag", start));
        memory.set("flag", start + Duration::seconds(10));
        assert!(memory.exists("flag", start + Duration::seconds(9)));
        assert!(!memory.exists("flag", start + Duration::seconds(10)));
        memory.set("flag", start + Duration::seconds(10));
        memory.clear("flag");
        assert!(!memory.exists("flag", start));
    }

    #[test]
    fn the_flag_lasts_until_the_next_utc_midnight() {
        let now = at("2026-10-25T16:59:30Z");
        assert_eq!(flag_key(now), "assistant:openrouter_exhausted:2026-10-25");
        assert_eq!(next_utc_midnight(now), at("2026-10-26T00:00:00Z"));
        // At exactly midnight the new day's key is used and runs a full day.
        let midnight = at("2026-10-26T00:00:00Z");
        assert_eq!(
            flag_key(midnight),
            "assistant:openrouter_exhausted:2026-10-26"
        );
        assert_eq!(next_utc_midnight(midnight), at("2026-10-27T00:00:00Z"));
        assert_eq!(
            next_utc_midnight(at("2026-12-31T23:59:59Z")),
            at("2027-01-01T00:00:00Z")
        );
    }

    #[tokio::test]
    async fn the_flag_without_redis_follows_the_utc_day() {
        let state = AppState::default();
        // Far in the future: off the live flag, and out of reach of the real-time purge
        // in `Memory::incr` that parallel tests trigger.
        let now = at("2099-03-04T10:00:00Z");
        assert!(!exhausted_at(&state, now).await);
        mark_exhausted_at(&state, now).await;
        assert!(exhausted_at(&state, now).await);
        assert!(exhausted_at(&state, at("2099-03-04T23:59:59Z")).await);
        assert!(!exhausted_at(&state, at("2099-03-05T00:00:00Z")).await);
        clear_exhausted_at(&state, now).await;
        assert!(!exhausted_at(&state, now).await);
    }

    #[tokio::test]
    async fn public_flag_functions_round_trip_without_redis() {
        // Only this test touches today's flag; it clears it again.
        let state = AppState::default();
        clear_openrouter_exhausted(&state).await;
        assert!(!openrouter_exhausted(&state).await);
        mark_openrouter_exhausted(&state).await;
        assert!(openrouter_exhausted(&state).await);
        clear_openrouter_exhausted(&state).await;
        assert!(!openrouter_exhausted(&state).await);
    }

    async fn redis_state() -> AppState {
        let client = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
        AppState {
            redis: Some(ConnectionManager::new(client).await.unwrap()),
            ..AppState::default()
        }
    }
    #[tokio::test]
    #[ignore = "requires REDIS_URL"]
    async fn redis_counter_sets_one_expiry_and_flag_ends_at_midnight() {
        let state = redis_state().await;
        let store = Uuid::new_v4();
        let day = date("2026-10-25");
        for expected in 1..=3 {
            assert_eq!(
                take_message(&state, store, day, 2).await.unwrap(),
                if expected <= 2 {
                    QuotaOutcome::Allowed { used: expected }
                } else {
                    QuotaOutcome::Exceeded
                }
            );
        }
        let mut connection = state.redis.clone().unwrap();
        let key = format!("assistant:quota:{store}:{day}");
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert!((172_700..=172_800).contains(&ttl), "{ttl}");
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<i64>(&mut connection)
            .await
            .unwrap();

        // A fixed far-away "now" keeps this off the live flag key.
        let now = at("2099-03-04T23:00:00Z");
        assert!(!exhausted_at(&state, now).await);
        mark_exhausted_at(&state, now).await;
        assert!(exhausted_at(&state, now).await);
        let ttl: i64 = redis::cmd("TTL")
            .arg(flag_key(now))
            .query_async(&mut connection)
            .await
            .unwrap();
        assert!((1..=3600).contains(&ttl), "{ttl}");
        clear_exhausted_at(&state, now).await;
        assert!(!exhausted_at(&state, now).await);
    }
}
