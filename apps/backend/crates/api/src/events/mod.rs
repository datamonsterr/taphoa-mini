pub mod hub;
pub mod relay;
pub use hub::{Hub, HubMessage};

use crate::{ApiError, ApiResult, AppState, auth::Actor};
use axum::{
    extract::State,
    http::HeaderMap,
    response::{
        Sse,
        sse::{Event as SseEvent, KeepAlive},
    },
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use futures_util::{Stream, stream};
use serde_json::{Value, json};
use std::{collections::VecDeque, convert::Infallible, time::Duration};
use tokio::{sync::watch, task::JoinHandle};
use uuid::Uuid;

pub struct Event {
    pub store_id: Uuid,
    pub actor: Option<(Uuid, Uuid)>,
    pub typ: &'static str,
    pub version: i32,
    pub data: Value,
    pub change: Option<(&'static str, Uuid, &'static str)>,
}
#[derive(Debug, Clone)]
pub struct EmittedEvent {
    pub id: i64,
    pub seq: Option<i64>,
    pub payload: Value,
}

pub fn router() -> axum::Router<crate::AppState> {
    axum::Router::new().route("/v1/events", get(stream_events))
}

/// Start the outbox relay and this instance's Redis fan-out subscriber.
pub fn spawn_background(state: &AppState, shutdown: watch::Receiver<bool>) -> Vec<JoinHandle<()>> {
    state.hub.set_shutdown(shutdown.clone());
    let Some((pool, redis_url)) = state.postgres.as_ref().zip(
        state
            .config
            .as_ref()
            .and_then(|config| config.redis_url.as_ref()),
    ) else {
        return Vec::new();
    };
    vec![
        state
            .hub
            .spawn_subscriber(redis_url.clone(), shutdown.clone()),
        relay::spawn(pool.clone(), redis_url.clone(), shutdown),
    ]
}

async fn stream_events(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
) -> ApiResult<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>> {
    // Subscribe before the replay query so commits during replay are buffered.
    let subscription = state.hub.subscribe(actor.store_id);
    let mut shutdown = state.hub.shutdown_signal();
    let mut last_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_event_id);
    let mut replay = VecDeque::new();
    let mut replay_open = false;
    if let Some(last_id) = last_id {
        let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
        tokio::select! {
            biased;
            () = stopped(&mut shutdown) => {},
            page = replay_page(pool, actor.store_id, last_id) => {
                let page = page?;
                replay_open = page.len() == REPLAY_PAGE;
                replay.extend(page);
            }
        }
    } else if let Some(pool) = &state.postgres {
        // A live connection starts at the current store watermark. Older commits
        // can still be waiting in the relay and must not become live history.
        let watermark = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(id), 0) FROM outbox_events WHERE store_id=$1",
        )
        .bind(actor.store_id)
        .fetch_one(pool);
        tokio::select! {
            biased;
            () = stopped(&mut shutdown) => {},
            id = watermark => last_id = Some(id?),
        }
    }
    let pool = state.postgres.clone();
    let (store_id, session_id) = (actor.store_id, actor.session_id);
    let stream = stream::unfold(
        (
            subscription,
            replay,
            replay_open,
            last_id.unwrap_or(0),
            false,
            shutdown,
        ),
        move |(
            mut subscription,
            mut replay,
            mut replay_open,
            mut last_id,
            closing,
            mut shutdown,
        )| {
            let pool = pool.clone();
            async move {
                if closing {
                    return None;
                }
                loop {
                    // Page through the backlog lazily so a long offline gap is never dropped.
                    if replay.is_empty() && replay_open {
                        let pool = pool.as_ref()?;
                        match replay_page(pool, store_id, last_id).await {
                            Ok(page) => {
                                replay_open = page.len() == REPLAY_PAGE;
                                replay.extend(page);
                            }
                            Err(_) => return None,
                        }
                    }
                    let message = tokio::select! {
                        biased;
                        () = stopped(&mut shutdown) => return None,
                        message = async {
                            if let Some(message) = replay.pop_front() {
                                Ok(message)
                            } else {
                                subscription.recv().await
                            }
                        } => match message {
                            Ok(message) => message,
                            // A slow client reconnects using its last successfully received id.
                            Err(_) => return None,
                        }
                    };
                    if message.id <= last_id {
                        continue;
                    }
                    last_id = message.id;
                    // Deliver the revocation, then end the stream for the revoked session.
                    let closing = ends_session(&message, session_id);
                    let event = SseEvent::default()
                        .id(format!("evt_{last_id:015}"))
                        .event(&message.event_type)
                        .data(&message.payload);
                    return Some((
                        Ok(event),
                        (
                            subscription,
                            replay,
                            replay_open,
                            last_id,
                            closing,
                            shutdown,
                        ),
                    ));
                }
            }
        },
    );
    // axum's Sse sets text/event-stream and Cache-Control: no-cache.
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(state.hub.heartbeat())
            .text("ping"),
    ))
}

const REPLAY_PAGE: usize = 1000;

async fn replay_page(
    pool: &sqlx::PgPool,
    store_id: Uuid,
    after: i64,
) -> Result<Vec<std::sync::Arc<HubMessage>>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i64, String, Value)>(
        "SELECT id, type, payload FROM outbox_events WHERE store_id=$1 AND id > $2 ORDER BY id LIMIT $3",
    )
    .bind(store_id)
    .bind(after)
    .bind(REPLAY_PAGE as i64)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, event_type, payload)| {
            std::sync::Arc::new(HubMessage {
                id,
                event_type,
                payload: payload.to_string(),
            })
        })
        .collect())
}

/// True when `message` revokes the session that owns this stream.
fn ends_session(message: &HubMessage, session_id: Uuid) -> bool {
    message.event_type == "session.revoked"
        && serde_json::from_str::<Value>(&message.payload)
            .ok()
            .and_then(|envelope| {
                envelope["data"]["session_id"]
                    .as_str()
                    .and_then(|id| id.parse::<Uuid>().ok())
            })
            == Some(session_id)
}

fn parse_event_id(value: &str) -> Option<i64> {
    let digits = value.strip_prefix("evt_")?;
    (digits.len() == 15 && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow_and_update() || shutdown.changed().await.is_err() {
            return;
        }
    }
}

struct Backoff(Duration);
impl Default for Backoff {
    fn default() -> Self {
        Self(Duration::from_millis(200))
    }
}
impl Backoff {
    fn reset(&mut self) {
        *self = Self::default();
    }
    async fn sleep(&mut self) {
        tokio::time::sleep(self.0).await;
        self.0 = (self.0 * 2).min(Duration::from_secs(10));
    }
}

/// Call with `&mut *tx` from a caller-owned transaction. Does not commit.
/// PostgreSQL delivers the notification only when that transaction commits.
///
/// Ordering rule: `change_log.seq` and `outbox_events.id` are cursors, so within one
/// store their allocation order must equal commit order, otherwise a reader holding a
/// later cursor would skip a row that commits afterwards. `emit` therefore takes a
/// transaction-scoped row lock on the store (`FOR NO KEY UPDATE`, the same lock the
/// store handlers already take, and compatible with foreign-key checks) before it
/// allocates any id. Never write `change_log` or `outbox_events` outside `emit`.
pub async fn emit(tx: &mut sqlx::PgConnection, event: Event) -> Result<EmittedEvent, sqlx::Error> {
    sqlx::query("SELECT id FROM stores WHERE id=$1 FOR NO KEY UPDATE")
        .bind(event.store_id)
        .fetch_optional(&mut *tx)
        .await?;
    let seq = if let Some((entity, entity_id, op)) = event.change {
        Some(sqlx::query_scalar::<_, i64>("INSERT INTO change_log (store_id, entity, entity_id, op) VALUES ($1,$2,$3,$4) RETURNING seq")
            .bind(event.store_id).bind(entity).bind(entity_id).bind(op).fetch_one(&mut *tx).await?)
    } else {
        None
    };
    // Identity columns use GENERATED ALWAYS: let INSERT allocate the ID, then fill
    // the envelope in the same transaction before any relay can observe it.
    let (id, occurred_at): (i64, DateTime<Utc>) = sqlx::query_as("INSERT INTO outbox_events (store_id, type, payload) VALUES ($1,$2,'{}'::jsonb) RETURNING id, created_at")
        .bind(event.store_id).bind(event.typ).fetch_one(&mut *tx).await?;
    let mut payload = json!({
        "id": format!("evt_{id:015}"), "type": event.typ, "version": event.version,
        "store_id": event.store_id,
        "occurred_at": occurred_at.with_timezone(&crate::time::STORE_TZ).to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
        "actor": event.actor.map(|(member_id, session_id)| json!({"member_id":member_id,"session_id":session_id})),
        "data": event.data,
    });
    if let Some(seq) = seq {
        payload["cursor"] = json!(URL_SAFE_NO_PAD.encode(seq.to_be_bytes()));
    }
    sqlx::query("UPDATE outbox_events SET payload=$2 WHERE id=$1")
        .bind(id)
        .bind(&payload)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_notify('outbox', $1)")
        .bind(id.to_string())
        .execute(&mut *tx)
        .await?;
    Ok(EmittedEvent { id, seq, payload })
}
pub async fn emit_many(
    tx: &mut sqlx::PgConnection,
    events: impl IntoIterator<Item = Event>,
) -> Result<Vec<EmittedEvent>, sqlx::Error> {
    let mut emitted = Vec::new();
    for event in events {
        emitted.push(emit(tx, event).await?);
    }
    Ok(emitted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_ids_require_the_complete_decimal_envelope_format() {
        assert_eq!(parse_event_id("evt_000000000000123"), Some(123));
        for invalid in [
            "123",
            "evt_123",
            "evt_00000000000012x",
            "evt_0000000000000123",
            "evt_-00000000000123",
            "evt_000000000000123\n",
        ] {
            assert_eq!(parse_event_id(invalid), None, "{invalid:?}");
        }
    }

    #[tokio::test]
    async fn shutdown_checks_the_current_value_and_ignores_false_updates() {
        let (signal, mut receiver) = watch::channel(true);
        stopped(&mut receiver).await;
        signal.send(false).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), stopped(&mut receiver))
                .await
                .is_err()
        );
        signal.send(true).unwrap();
        stopped(&mut receiver).await;
    }
}
