//! Real API -> transactional outbox -> Redis commit -> product analytics.
mod common;
use async_trait::async_trait;
use axum::http::StatusCode;
use common::world::{World, now_iso, sale_body};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use taphoa_api::analytics::{Analytics, CaptureEvent};
use tokio::sync::Mutex;
use uuid::Uuid;
#[derive(Default)]
struct Recording(Mutex<Vec<CaptureEvent>>);
#[async_trait]
impl Analytics for Recording {
    async fn capture_event(&self, event: CaptureEvent) -> anyhow::Result<()> {
        self.0.lock().await.push(event);
        Ok(())
    }
}
#[tokio::test]
async fn sale_is_captured_only_after_publish_commit() {
    if std::env::var("DATABASE_URL").is_err() || std::env::var("REDIS_URL").is_err() {
        return;
    }
    let mut w = World::new().await;
    let recording = Arc::new(Recording::default());
    w.state.analytics = recording.clone();
    let product = w.product("analytics", 5000, None).await;
    let id = Uuid::now_v7();
    let sale = w
        .call(
            "POST",
            "/v1/sales",
            &w.seller,
            sale_body(id, &now_iso(), "cash", &[(product, 2, 5000)]),
        )
        .await;
    assert_eq!(sale.status, StatusCode::CREATED, "{}", sale.body);
    let envelope: serde_json::Value = sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE store_id=$1 AND type='sale.created'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    let outbox_id = envelope["id"]
        .as_str()
        .unwrap()
        .trim_start_matches("evt_")
        .parse::<i64>()
        .unwrap();
    let redis = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
    let mut redis = redis::aio::ConnectionManager::new(redis).await.unwrap();
    for _ in 0..100 {
        let (count, failed) = taphoa_api::events::relay::publish_once(
            w.pool(),
            &mut redis,
            w.state.analytics.clone(),
        )
        .await
        .unwrap();
        assert!(!failed);
        if count < 100 {
            break;
        }
    }
    let captured = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(event) = recording
                .0
                .lock()
                .await
                .iter()
                .find(|e| e.event == "sale_completed" && e.distinct_id == w.seller_id.to_string())
                .cloned()
            {
                break event;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(captured.groups["store"], json!(w.store_id));
    assert_eq!(captured.properties["total"], 10000);
    assert_eq!(captured.properties["has_credit"], false);
    assert_eq!(captured.properties["manual_lines"], 0);
    assert_eq!(
        captured.uuid,
        Some(Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            outbox_id.to_string().as_bytes()
        ))
    );
    assert_eq!(
        captured.timestamp,
        Some(
            chrono::DateTime::parse_from_rfc3339(envelope["occurred_at"].as_str().unwrap())
                .unwrap()
                .to_utc()
        )
    );
    let published: bool =
        sqlx::query_scalar("SELECT published_at IS NOT NULL FROM outbox_events WHERE id=$1")
            .bind(outbox_id)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert!(published);
}

#[tokio::test]
async fn producer_metadata_is_additive_and_tracks_assistant_origin() {
    if std::env::var("DATABASE_URL").is_err() || std::env::var("REDIS_URL").is_err() {
        return;
    }
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let w = World::new().await;
    let created: serde_json::Value = sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE store_id=$1 AND type='store.created'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(created["actor"]["member_id"], w.lead_id.to_string());
    let product = w.product("metadata", 5000, None).await;
    for (method, path, body) in [
        (
            "POST",
            format!("/v1/products/{product}/stock-adjustments"),
            json!({"count":10}),
        ),
        (
            "POST",
            "/v1/expenses".into(),
            json!({"id":Uuid::now_v7(),"spent_at":now_iso(),"amount":1000,"category":"dien","paid_with":"cash","purchase_lines":[]}),
        ),
        (
            "PATCH",
            format!("/v1/products/{product}"),
            json!({"price":6000}),
        ),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(
                "content-type",
                if method == "PATCH" {
                    "application/merge-patch+json"
                } else {
                    "application/json"
                },
            )
            .header("authorization", format!("Bearer {}", w.lead))
            .header("x-taphoa-via", "assistant")
            .header("idempotency-key", Uuid::new_v4().to_string())
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = w.app.clone().oneshot(request).await.unwrap();
        assert!(
            response.status().is_success(),
            "{method}: {}",
            response.status()
        );
    }
    for kind in ["stock.changed", "expense.created", "price.changed"] {
        let data: serde_json::Value = sqlx::query_scalar("SELECT payload->'data' FROM outbox_events WHERE store_id=$1 AND type=$2 ORDER BY id DESC LIMIT 1").bind(w.store_id).bind(kind).fetch_one(w.pool()).await.unwrap();
        assert_eq!(data["via"], "assistant", "{kind}");
    }
    let id = Uuid::now_v7();
    let sale = w
        .call(
            "POST",
            "/v1/sales",
            &w.lead,
            sale_body(id, &now_iso(), "cash", &[(product, 1, 6000)]),
        )
        .await;
    assert_eq!(sale.status, StatusCode::CREATED, "{}", sale.body);
    let voided = w
        .call(
            "POST",
            &format!("/v1/sales/{id}/void"),
            &w.lead,
            json!({"reason":"mistake"}),
        )
        .await;
    assert!(voided.status.is_success(), "{}", voided.body);
    let data: serde_json::Value = sqlx::query_scalar("SELECT payload->'data' FROM outbox_events WHERE store_id=$1 AND type='sale.voided' ORDER BY id DESC LIMIT 1").bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    assert_eq!(data["same_day"], true);
}
