mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::{
    Contract,
    world::{World, now_iso, sale_body},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

async fn adjust(w: &World, p: Uuid, token: &str, key: &str, body: Value) -> (StatusCode, Value) {
    let response = w
        .app
        .clone()
        .oneshot(
            Request::post(format!("/v1/products/{p}/stock-adjustments"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("Idempotency-Key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status == StatusCode::OK {
        Contract::load().assert_conforms(
            "/v1/products/{productId}/stock-adjustments",
            "post",
            status,
            &value,
        );
    }
    (status, value)
}
async fn count(w: &World, p: Uuid, n: i32) -> Value {
    let (s, v) = adjust(
        w,
        p,
        &w.lead,
        &Uuid::new_v4().to_string(),
        json!({"count":n}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}
async fn quantity(w: &World, p: Uuid) -> Option<i32> {
    sqlx::query_scalar("SELECT stock_quantity FROM products WHERE id=$1")
        .bind(p)
        .fetch_one(w.pool())
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sales_void_units_untracked_and_atomic_rollback() {
    let w = World::new().await;
    let p = w.product("Tracked", 10, None).await;
    let u = w.product("Untracked", 10, None).await;
    count(&w, p, 20).await;
    let unit = Uuid::now_v7();
    sqlx::query("INSERT INTO product_units(id,store_id,product_id,name,quantity_in_base,price) VALUES($1,$2,$3,'pack',6,60)").bind(unit).bind(w.store_id).bind(p).execute(w.pool()).await.unwrap();
    let id = Uuid::now_v7();
    let mut body = sale_body(id, &now_iso(), "cash", &[(p, 2, 60), (u, 1, 10)]);
    body["lines"][0]["unit_id"] = json!(unit);
    body["lines"].as_array_mut().unwrap().push(json!({"id":Uuid::now_v7(),"product_id":null,"source":"manual","quantity":1,"unit_price":0}));
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body.clone(),
        StatusCode::CREATED,
    )
    .await;
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body,
        StatusCode::OK,
    )
    .await;
    assert_eq!(quantity(&w, p).await, Some(8));
    assert_eq!(quantity(&w, u).await, None);
    for _ in 0..2 {
        w.checked(
            "POST",
            &format!("/v1/sales/{id}/void"),
            "/v1/sales/{saleId}/void",
            &w.seller,
            json!({"reason":"return"}),
            StatusCode::OK,
        )
        .await;
    }
    assert_eq!(quantity(&w, p).await, Some(20));
    assert_eq!(quantity(&w, u).await, None);
    let history = w
        .checked(
            "GET",
            &format!("/v1/products/{p}/stock-movements?limit=2"),
            "/v1/products/{productId}/stock-movements",
            &w.seller,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(history["items"][0]["reason"], "sale_void");
    assert_eq!(history["items"][0]["delta"], 12);
    assert_eq!(history["items"][1]["delta"], -12);
    assert_eq!(history["items"][1]["ref_id"], id.to_string());
    let c = history["next_cursor"].as_str().unwrap();
    let next = w
        .checked(
            "GET",
            &format!("/v1/products/{p}/stock-movements?limit=2&cursor={c}"),
            "/v1/products/{productId}/stock-movements",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_eq!(w.events("stock.changed").await, 3);
    let mut bad = sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(p, 1, 10)]);
    bad["scan_ids"] = json!([Uuid::new_v4()]);
    assert_eq!(
        w.call("POST", "/v1/sales", &w.seller, bad).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(quantity(&w, p).await, Some(20));
    assert_eq!(w.events("stock.changed").await, 3);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn adjustment_validation_permissions_and_replay() {
    let w = World::new().await;
    let p = w.product("Count", 10, None).await;
    for body in [
        json!({}),
        json!({"count":1,"delta":2}),
        json!({"count":-1}),
        json!({"delta":0}),
        json!({"count":null}),
        json!({"delta":2147483648_i64}),
        json!({"count":2,"note":"ạ".repeat(201)}),
    ] {
        assert_eq!(
            adjust(&w, p, &w.lead, &Uuid::new_v4().to_string(), body.clone())
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}"
        );
    }
    assert_eq!(
        adjust(&w, p, &w.seller, "seller", json!({"count":2}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        adjust(&w, p, &w.lead, "", json!({"count":2})).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let key = Uuid::new_v4().to_string();
    let body = json!({"count":12,"note":"counted"});
    let (a, b) = tokio::join!(
        adjust(&w, p, &w.lead, &key, body.clone()),
        adjust(&w, p, &w.lead, &key, body.clone())
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(a, b);
    assert_eq!(quantity(&w, p).await, Some(12));
    assert_eq!(w.events("stock.changed").await, 1);
    assert_eq!(
        adjust(&w, p, &w.lead, &key, json!({"count":13})).await.0,
        StatusCode::CONFLICT
    );
    let (_, d) = adjust(&w, p, &w.lead, "delta", json!({"delta":-20})).await;
    assert_eq!(d["quantity_after"], -8);
    let (_, replay) = adjust(&w, p, &w.lead, &key, body).await;
    assert_eq!(replay, a.1);
    assert_eq!(count(&w, p, 0).await["delta"], 8);
    let other = World::new().await;
    assert_eq!(
        adjust(&other, p, &other.lead, "foreign", json!({"count":2}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        other
            .call(
                "GET",
                &format!("/v1/products/{p}/stock-movements"),
                &other.lead,
                json!(null)
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn threshold_crossings_override_product_store_and_sync_fields() {
    let w = World::new().await;
    let p = w.product("Threshold", 10, None).await;
    let store = w
        .checked(
            "PATCH",
            "/v1/store",
            "/v1/store",
            &w.lead,
            json!({"low_stock_threshold":7}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(store["low_stock_threshold"], 7);
    let patch = format!("/v1/products/{p}");
    assert_eq!(
        w.call("PATCH", &patch, &w.seller, json!({"low_stock_threshold":2}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let product = w
        .checked(
            "PATCH",
            &patch,
            "/v1/products/{productId}",
            &w.lead,
            json!({"low_stock_threshold":2}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(product["stock_status"], "untracked");
    count(&w, p, 9).await;
    count(&w, p, 7).await;
    assert_eq!(w.events("stock.low").await, 0);
    count(&w, p, 2).await;
    count(&w, p, 1).await;
    assert_eq!(w.events("stock.low").await, 1);
    count(&w, p, 3).await;
    count(&w, p, 2).await;
    assert_eq!(w.events("stock.low").await, 2);
    let payload:Value=sqlx::query_scalar("SELECT payload->'data' FROM outbox_events WHERE store_id=$1 AND type='stock.low' ORDER BY id DESC LIMIT 1").bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    assert_eq!(
        payload,
        json!({"product_id":p,"name":"Threshold","stock_quantity":2,"threshold":2})
    );
    let product = w
        .checked(
            "PATCH",
            &patch,
            "/v1/products/{productId}",
            &w.lead,
            json!({"low_stock_threshold":null}),
            StatusCode::OK,
        )
        .await;
    assert!(product["low_stock_threshold"].is_null());
    assert_eq!(product["stock_status"], "low");
    assert_eq!(product["stock_quantity"], 2);
    count(&w, p, 8).await;
    count(&w, p, 7).await;
    assert_eq!(w.events("stock.low").await, 3);
    let feed = w
        .call("GET", "/v1/sync/changes", &w.lead, json!(null))
        .await;
    assert_eq!(feed.status, StatusCode::OK);
    assert!(feed.body.to_string().contains("stock_quantity"));
    assert_eq!(
        w.call(
            "PATCH",
            "/v1/store",
            &w.seller,
            json!({"low_stock_threshold":2})
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    for value in [-1, 100001] {
        assert!(
            !w.call(
                "PATCH",
                "/v1/store",
                &w.lead,
                json!({"low_stock_threshold":value})
            )
            .await
            .status
            .is_success()
        );
        assert!(
            !w.call(
                "PATCH",
                &patch,
                &w.lead,
                json!({"low_stock_threshold":value})
            )
            .await
            .status
            .is_success()
        );
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn stock_order_filters_pagination_and_archived() {
    let w = World::new().await;
    let mut ids = vec![];
    for (name, n) in [
        ("Z out", 0),
        ("A out", 0),
        ("B low", 5),
        ("A ok", 20),
        ("Untracked", -1),
        ("Archived", 0),
    ] {
        let p = w.product(name, 10, None).await;
        ids.push(p);
        if n >= 0 {
            count(&w, p, n).await;
        }
    }
    sqlx::query("UPDATE products SET archived=true WHERE id=$1")
        .bind(ids[5])
        .execute(w.pool())
        .await
        .unwrap();
    let mut seen = vec![];
    let mut suffix = String::new();
    loop {
        let page = w
            .checked(
                "GET",
                &format!("/v1/stock?limit=1{suffix}"),
                "/v1/stock",
                &w.seller,
                json!(null),
                StatusCode::OK,
            )
            .await;
        for item in page["items"].as_array().unwrap() {
            seen.push(
                item["product_id"]
                    .as_str()
                    .unwrap()
                    .parse::<Uuid>()
                    .unwrap(),
            );
        }
        match page["next_cursor"].as_str() {
            Some(c) => suffix = format!("&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(seen, vec![ids[1], ids[0], ids[2], ids[3]]);
    for (filter, n) in [("low", 3), ("out", 2), ("all", 4)] {
        let page = w
            .checked(
                "GET",
                &format!("/v1/stock?status={filter}"),
                "/v1/stock",
                &w.lead,
                json!(null),
                StatusCode::OK,
            )
            .await;
        assert_eq!(page["items"].as_array().unwrap().len(), n);
    }
    assert!(
        !w.call("GET", "/v1/stock?status=bad", &w.lead, json!(null))
            .await
            .status
            .is_success()
    );
    assert!(
        !w.call("GET", "/v1/stock?cursor=bad", &w.lead, json!(null))
            .await
            .status
            .is_success()
    );
    let other = World::new().await;
    assert!(
        other
            .call("GET", "/v1/stock", &other.lead, json!(null))
            .await
            .body["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn receipt_apply_starts_tracking_and_concurrent_deltas_serialize() {
    use taphoa_api::stock::{self, Change};
    let w = World::new().await;
    let p = w.product("Receipt", 10, None).await;
    let reference = Uuid::now_v7();
    let mut tx = w.pool().begin().await.unwrap();
    let movement = stock::apply(
        &mut tx,
        w.store_id,
        p,
        Change::Delta(12),
        "receipt",
        Some(reference),
        Some(w.lead_id),
        None,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(movement.quantity_after, 12);
    assert_eq!(movement.ref_id, Some(reference));
    tx.rollback().await.unwrap();
    assert_eq!(quantity(&w, p).await, None);
    assert_eq!(w.events("stock.changed").await, 0);
    let mut tx = w.pool().begin().await.unwrap();
    stock::apply(
        &mut tx,
        w.store_id,
        p,
        Change::Delta(12),
        "receipt",
        Some(reference),
        Some(w.lead_id),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let (a, b) = tokio::join!(
        adjust(&w, p, &w.lead, "one", json!({"delta":1})),
        adjust(&w, p, &w.lead, "two", json!({"delta":1}))
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(quantity(&w, p).await, Some(14));
    count(&w, p, i32::MAX).await;
    assert_eq!(
        adjust(&w, p, &w.lead, "overflow", json!({"delta":1}))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}
