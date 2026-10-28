//! Daily utterance cap per store: `voice:quota:{store}:{business date}` in Redis (process-local
//! map without Redis), the same counter the assistant uses.
use crate::{ApiError, AppState, assistant::quota::incr, time::STORE_TZ};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

const QUOTA_TTL_SECS: i64 = 172_800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaOutcome {
    Allowed { used: u32 },
    Exceeded,
}

pub fn key(store: Uuid, now: DateTime<Utc>) -> String {
    format!("voice:quota:{store}:{}", crate::time::business_date(now))
}

/// Seconds until the next local midnight (when the business date rolls over).
pub fn seconds_to_reset(now: DateTime<Utc>) -> u64 {
    let local = now.with_timezone(&STORE_TZ);
    let next = (local.date_naive() + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(STORE_TZ).earliest())
        .map_or(3600, |t| (t.with_timezone(&Utc) - now).num_seconds());
    next.clamp(1, 86_400) as u64
}

pub async fn take(state: &AppState, store: Uuid, cap: u32) -> Result<QuotaOutcome, ApiError> {
    let now = Utc::now();
    let used = incr(state, &key(store, now), QUOTA_TTL_SECS, now)
        .await
        .map_err(|error| {
            tracing::error!(%error, "voice quota counter failed");
            ApiError::unavailable()
        })?;
    Ok(match u32::try_from(used) {
        Ok(used) if used <= cap => QuotaOutcome::Allowed { used },
        _ => QuotaOutcome::Exceeded,
    })
}

pub fn exceeded() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "voice_quota",
        "daily voice limit reached for this store",
    )
    .with_retry_after(seconds_to_reset(Utc::now()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn key_uses_the_business_date() {
        let store = Uuid::nil();
        // 18:00 UTC is already the next day in Ho Chi Minh (UTC+7).
        let at = Utc.with_ymd_and_hms(2026, 10, 27, 18, 0, 0).unwrap();
        assert_eq!(key(store, at), format!("voice:quota:{store}:2026-10-28"));
    }
    #[test]
    fn reset_is_at_local_midnight() {
        // 16:30 UTC = 23:30 local: 30 minutes to midnight.
        let at = Utc.with_ymd_and_hms(2026, 10, 27, 16, 30, 0).unwrap();
        assert_eq!(seconds_to_reset(at), 1800);
    }
}
