//! Expense transaction and concurrency regressions beyond the shared acceptance suite.
mod common;
use axum::http::StatusCode;
use common::world::{World, now_iso};
use serde_json::{Value, json};
use uuid::Uuid;

fn purchase(product: Uuid, cost: i64) -> Value {
    json!({"id":Uuid::now_v7(),"spent_at":now_iso(),"amount":cost,"category":"nhap_hang","paid_with":"cash_box",
        "purchase_lines":[{"product_id":product,"quantity":1,"unit_cost":cost}]})
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn concurrent_purchase_replay_has_one_set_of_side_effects() {
    let w = World::new().await;
    let product = w.product("Coca", 10000, Some(5000)).await;
    let body = purchase(product, 11000);
    let (first, second) = tokio::join!(
        w.call("POST", "/v1/expenses", &w.seller, body.clone()),
        w.call("POST", "/v1/expenses", &w.seller, body)
    );
    let mut statuses = [first.status.as_u16(), second.status.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 201]);
    assert_eq!(first.body, second.body);
    assert_eq!(w.events("expense.created").await, 1);
    assert_eq!(w.events("alert.created").await, 1);
    let histories: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM price_history WHERE product_id=$1 AND source='purchase'",
    )
    .bind(product)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(histories, 1);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn rejected_later_purchase_line_rolls_back_earlier_writes() {
    let w = World::new().await;
    let other = World::new().await;
    let product = w.product("Coca", 10000, Some(5000)).await;
    let foreign = other.product("Tea", 10000, None).await;
    let mut body = purchase(product, 11000);
    body["amount"] = json!(22000);
    body["purchase_lines"]
        .as_array_mut()
        .unwrap()
        .push(json!({"product_id":foreign,"quantity":1,"unit_cost":11000}));
    let result = w.call("POST", "/v1/expenses", &w.lead, body.clone()).await;
    assert_eq!(result.status, StatusCode::NOT_FOUND);
    let cost: i64 = sqlx::query_scalar("SELECT cost_price FROM products WHERE id=$1")
        .bind(product)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(cost, 5000);
    let expenses: i64 = sqlx::query_scalar("SELECT count(*) FROM expenses WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(expenses, 0);
    assert_eq!(w.events("expense.created").await, 0);
    assert_eq!(w.events("alert.created").await, 0);
    body["purchase_lines"].as_array_mut().unwrap().pop();
    body["amount"] = json!(11000);
    body["purchase_lines"][0]["unit_id"] = json!(Uuid::now_v7());
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.lead, body).await.status,
        StatusCode::NOT_FOUND
    );
    let mut image = purchase(product, 11000);
    image["image_id"] = json!(Uuid::now_v7());
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.lead, image).await.status,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn purchase_auto_dismisses_and_corrections_preserve_purchase_cost() {
    let w = World::new().await;
    w.set_margin_threshold(12.5).await;
    let product = w.product("Coca", 10000, Some(5000)).await;
    let body = purchase(product, 8800);
    let expense_id = body["id"].as_str().unwrap().to_owned();
    let raised = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.seller,
            body,
            StatusCode::CREATED,
        )
        .await;
    let alert_id = raised["alerts"][0]["id"].as_str().unwrap();
    assert_eq!(raised["alerts"][0]["margin_pct"], 12.0);
    let expense_path = format!("/v1/expenses/{expense_id}");
    for patch in [
        json!({"amount":1}),
        json!({"category":"dien"}),
        json!({"purchase_lines":[]}),
    ] {
        assert_eq!(
            w.call("PATCH", &expense_path, &w.seller, patch)
                .await
                .status,
            StatusCode::BAD_REQUEST
        );
    }
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.seller,
        purchase(product, 5000),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(w.events("alert.resolved").await, 1);
    let alerts = w
        .call("GET", "/v1/alerts?status=dismissed", &w.lead, Value::Null)
        .await;
    assert_eq!(alerts.body["items"][0]["id"], alert_id);
    assert_eq!(
        w.call(
            "POST",
            &format!("/v1/alerts/{alert_id}/accept"),
            &w.lead,
            json!({})
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        w.call("DELETE", &expense_path, &w.lead, Value::Null)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let cost: i64 = sqlx::query_scalar("SELECT cost_price FROM products WHERE id=$1")
        .bind(product)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(cost, 5000);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn zero_price_and_large_negative_margin_remain_valid_alerts() {
    let w = World::new().await;
    for price in [0, 1] {
        let product = w.product("Low price", price, None).await;
        let e = w
            .checked(
                "POST",
                "/v1/expenses",
                "/v1/expenses",
                &w.lead,
                purchase(product, 10000),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(e["alerts"].as_array().unwrap().len(), 1);
        let id = e["alerts"][0]["id"].as_str().unwrap();
        w.checked(
            "POST",
            &format!("/v1/alerts/{id}/accept"),
            "/v1/alerts/{alertId}/accept",
            &w.lead,
            json!({"new_price":0}),
            StatusCode::OK,
        )
        .await;
    }
    let changes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM change_log WHERE store_id=$1 AND entity='product'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(changes, 2);
}

struct ReceiptSigner;
#[async_trait::async_trait]
impl taphoa_api::storage::ObjectStore for ReceiptSigner {
    async fn put(&self, _: &str, _: &str, _: Vec<u8>) -> anyhow::Result<()> {
        anyhow::bail!("expense responses must not upload objects")
    }
    async fn delete(&self, _: &str) -> anyhow::Result<()> {
        anyhow::bail!("expense responses must not delete objects")
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(
        &self,
        key: &str,
        ttl: std::time::Duration,
    ) -> anyhow::Result<taphoa_api::storage::SignedUrl> {
        Ok(taphoa_api::storage::SignedUrl {
            url: format!("https://receipts.example.test/{key}?signature=expense-test"),
            expires_at: chrono::Utc::now() + chrono::Duration::from_std(ttl)?,
        })
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn expense_receipts_are_scoped_and_presigned_and_patch_can_clear_them() {
    let mut w = World::new().await;
    let other = World::new().await;
    w.state.storage = Some(std::sync::Arc::new(ReceiptSigner));
    w.app = taphoa_api::router(w.state.clone());
    let image = Uuid::now_v7();
    let foreign = Uuid::now_v7();
    for (id, store) in [(image, w.store_id), (foreign, other.store_id)] {
        sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose) VALUES ($1,$2,$3,'image/jpeg',100,'expense_receipt')")
            .bind(id).bind(store).bind(format!("images/receipts/{id}.jpg")).execute(w.pool()).await.unwrap();
    }
    let mut body = json!({"id":Uuid::now_v7(),"spent_at":now_iso(),"amount":1000,"category":"khac","paid_with":"other","image_id":image});
    let path = format!("/v1/expenses/{}", body["id"].as_str().unwrap());
    let e = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.seller,
            body.clone(),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(e["image"]["id"], image.to_string());
    assert!(
        e["image"]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://receipts.example.test/images/receipts/")
    );
    assert!(e["image"]["url_expires_at"].as_str().is_some());
    w.checked(
        "GET",
        &path,
        "/v1/expenses/{expenseId}",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        w.call("PATCH", &path, &w.seller, json!({"image_id":foreign}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    w.checked(
        "PATCH",
        &path,
        "/v1/expenses/{expenseId}",
        &w.seller,
        json!({"image_id":null}),
        StatusCode::OK,
    )
    .await;
    let cleared = w.call("GET", &path, &w.lead, Value::Null).await;
    assert!(cleared.body["image"].is_null());
    body["id"] = json!(Uuid::now_v7());
    body["image_id"] = json!(foreign);
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.seller, body).await.status,
        StatusCode::NOT_FOUND
    );
}
