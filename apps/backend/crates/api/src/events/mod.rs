use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
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
    axum::Router::new()
}

/// Call with `&mut *tx` from a caller-owned transaction. Does not commit.
/// PostgreSQL delivers the notification only when that transaction commits.
pub async fn emit(tx: &mut sqlx::PgConnection, event: Event) -> Result<EmittedEvent, sqlx::Error> {
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
