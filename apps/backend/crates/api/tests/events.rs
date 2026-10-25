//! Real Postgres proof for the caller-owned transactional outbox.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::json;
use sqlx::{PgPool, Row, postgres::PgListener};
use taphoa_api::events::{Event, emit, emit_many};
use uuid::Uuid;

fn event(store_id: Uuid, actor: Option<(Uuid, Uuid)>, change: bool) -> Event {
    Event {
        store_id,
        actor,
        typ: "product.updated",
        version: 1,
        data: json!({"name":"test"}),
        change: change.then(|| ("product", Uuid::new_v4(), "upsert")),
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and the E1 schema"]
async fn emits_complete_envelope_atomically_and_notifies_on_commit() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let pool = PgPool::connect(&database_url).await.unwrap();
    let mut listener = PgListener::connect(&database_url).await.unwrap();
    listener.listen("outbox").await.unwrap();
    let store_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO stores (id,name,recovery_code_hash) VALUES ($1,'event test','fixture')",
    )
    .bind(store_id)
    .execute(&pool)
    .await
    .unwrap();
    let actor = (Uuid::new_v4(), "sess_clerk_event".to_string());
    let mut tx = pool.begin().await.unwrap();
    let emitted = emit(&mut tx, event(store_id, Some(actor), true))
        .await
        .unwrap();
    assert_eq!(emitted.payload["id"], format!("evt_{:015}", emitted.id));
    assert_eq!(emitted.payload["type"], "product.updated");
    assert_eq!(emitted.payload["version"], 1);
    assert_eq!(emitted.payload["store_id"], store_id.to_string());
    assert_eq!(
        emitted.payload["actor"],
        json!({"member_id":actor.0,"session_id":actor.1})
    );
    assert_eq!(emitted.payload["data"], json!({"name":"test"}));
    let timestamp = emitted.payload["occurred_at"].as_str().unwrap();
    assert!(timestamp.ends_with("+07:00"));
    assert!(chrono::DateTime::parse_from_rfc3339(timestamp).is_ok());
    let seq = emitted.seq.unwrap();
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(emitted.payload["cursor"].as_str().unwrap())
            .unwrap(),
        seq.to_be_bytes()
    );
    let row = sqlx::query("SELECT entity, op FROM change_log WHERE seq=$1 AND store_id=$2")
        .bind(seq)
        .bind(store_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("entity"), "product");
    assert_eq!(row.get::<String, _>("op"), "upsert");
    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT payload FROM outbox_events WHERE id=$1")
            .bind(emitted.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(stored, emitted.payload);
    let before_commit: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE id=$1")
        .bind(emitted.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before_commit, 0);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), listener.recv())
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    let notification = tokio::time::timeout(std::time::Duration::from_secs(2), listener.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notification.payload(), emitted.id.to_string());
    let committed: serde_json::Value =
        sqlx::query_scalar("SELECT payload FROM outbox_events WHERE id=$1")
            .bind(emitted.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(committed, emitted.payload);
    let mut tx = pool.begin().await.unwrap();
    let batch = emit_many(
        &mut tx,
        [
            event(store_id, None, false),
            event(store_id, Some(actor), true),
        ],
    )
    .await
    .unwrap();
    assert_eq!(batch.len(), 2);
    assert!(batch[0].seq.is_none());
    assert!(batch[0].payload.get("cursor").is_none());
    assert!(batch[0].payload["actor"].is_null());
    let ids: Vec<_> = batch.iter().map(|e| e.id).collect();
    let rolled_seq = batch[1].seq.unwrap();
    tx.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE id=ANY($1)")
        .bind(ids)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM change_log WHERE seq=$1")
        .bind(rolled_seq)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(store_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
