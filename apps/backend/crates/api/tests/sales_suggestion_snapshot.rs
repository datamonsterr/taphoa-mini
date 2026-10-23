//! Regression: an offline recommendation snapshot need not exist in the current catalog.
mod common;
use axum::http::StatusCode;
use common::world::{World, sale_body};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn missing_suggested_product_is_preserved_as_a_snapshot() {
    let w = World::new().await;
    let product = w.product("Confirmed", 1000, None).await;
    let suggestion = Uuid::new_v4();
    let (scan, detection) = w.scan_fixture().await;
    let sale = Uuid::now_v7();
    let mut body = sale_body(
        sale,
        "2026-03-05T10:00:00+07:00",
        "transfer",
        &[(product, 1, 1000)],
    );
    body["scan_ids"] = json!([scan]);
    body["lines"][0]["detection_id"] = json!(detection);
    body["lines"][0]["suggested_product_id"] = json!(suggestion);
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body,
        StatusCode::CREATED,
    )
    .await;
    let stored: Uuid =
        sqlx::query_scalar("SELECT suggested_product_id FROM sale_lines WHERE sale_id=$1")
            .bind(sale)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(stored, suggestion);
    // Known suggestions in another store remain forbidden too.
    // The selected product must still belong to this store.
    let other = World::new().await;
    let foreign_product = other.product("Other store", 1000, None).await;
    let invalid = sale_body(
        Uuid::now_v7(),
        "2026-03-05T10:00:00+07:00",
        "transfer",
        &[(foreign_product, 1, 1000)],
    );
    assert_eq!(
        w.call("POST", "/v1/sales", &w.seller, invalid).await.status,
        StatusCode::NOT_FOUND
    );
    let mut foreign_suggestion = sale_body(
        Uuid::now_v7(),
        "2026-03-05T10:00:00+07:00",
        "transfer",
        &[(product, 1, 1000)],
    );
    foreign_suggestion["lines"][0]["suggested_product_id"] = json!(foreign_product);
    assert_eq!(
        w.call("POST", "/v1/sales", &w.seller, foreign_suggestion)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}
