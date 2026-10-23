//! E4 expenses, purchase lines and margin alerts against real Postgres and Redis.
mod common;
use axum::http::StatusCode;
use common::world::{World, now_iso};
use serde_json::{Value, json};
use uuid::Uuid;

fn expense(id: Uuid, amount: i64, category: &str) -> Value {
    json!({"id": id, "spent_at": now_iso(), "amount": amount, "category": category, "paid_with": "cash_box", "note": "điện tháng 10"})
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn expense_crud_authz_idempotency() {
    let w = World::new().await;
    let id = Uuid::now_v7();
    let body = expense(id, 350_000, "dien");
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
    assert_eq!(e["member_id"], w.seller_id.to_string());
    assert_eq!(e["amount"], 350_000);
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.seller,
        body.clone(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(w.events("expense.created").await, 1);
    let mut changed = body.clone();
    changed["amount"] = json!(1);
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.seller, changed)
            .await
            .status,
        StatusCode::CONFLICT
    );
    for bad in [
        json!({"amount":0}),
        json!({"amount":-5}),
        json!({"category":"an_uong"}),
        json!({"paid_with":"card"}),
        json!({"note":"x".repeat(501)}),
    ] {
        let mut b = expense(Uuid::now_v7(), 1000, "khac");
        b.as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        assert_eq!(
            w.call("POST", "/v1/expenses", &w.lead, b).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    let path = format!("/v1/expenses/{id}");
    w.checked(
        "GET",
        &path,
        "/v1/expenses/{expenseId}",
        &w.lead,
        json!(null),
        StatusCode::OK,
    )
    .await;
    // author may edit own, not others'
    let patched = w
        .checked(
            "PATCH",
            &path,
            "/v1/expenses/{expenseId}",
            &w.seller,
            json!({"amount": 360_000, "note": null}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(patched["amount"], 360_000);
    assert!(patched["note"].is_null());
    let lead_id = Uuid::now_v7();
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.lead,
        expense(lead_id, 5000, "nuoc"),
        StatusCode::CREATED,
    )
    .await;
    let lead_path = format!("/v1/expenses/{lead_id}");
    assert_eq!(
        w.call("PATCH", &lead_path, &w.seller, json!({"amount": 1}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.call("DELETE", &lead_path, &w.seller, json!(null))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.call("PATCH", &lead_path, &w.lead, json!({"amount": 0}))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.call("DELETE", &lead_path, &w.lead, json!(null))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        w.call("GET", &lead_path, &w.lead, json!(null)).await.status,
        StatusCode::NOT_FOUND
    );
    let list = w
        .checked(
            "GET",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        list["items"].as_array().unwrap().len(),
        1,
        "soft-deleted expenses are hidden"
    );
    let by_cat = w
        .call("GET", "/v1/expenses?category=nuoc", &w.lead, json!(null))
        .await;
    assert_eq!(by_cat.body["items"].as_array().unwrap().len(), 0);
    let other = World::new().await;
    assert_eq!(
        other
            .call("GET", &path, &other.lead, json!(null))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        other
            .call("DELETE", &path, &other.lead, json!(null))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        other
            .call("GET", "/v1/expenses", &other.lead, json!(null))
            .await
            .body["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn expense_pagination_and_date_filter() {
    let w = World::new().await;
    for i in 1..=5 {
        let mut b = expense(Uuid::now_v7(), 1000 * i, "khac");
        b["spent_at"] = json!(format!("2026-05-0{i}T09:00:00+07:00"));
        w.checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            b,
            StatusCode::CREATED,
        )
        .await;
    }
    let p1 = w
        .checked(
            "GET",
            "/v1/expenses?limit=2",
            "/v1/expenses",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(p1["items"][0]["amount"], 5000, "newest first");
    let c = p1["next_cursor"].as_str().unwrap();
    let p2 = w
        .call(
            "GET",
            &format!("/v1/expenses?limit=2&cursor={c}"),
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(p2.body["items"][0]["amount"], 3000);
    let ranged = w
        .call(
            "GET",
            "/v1/expenses?from=2026-05-02&to=2026-05-03",
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(ranged.body["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn purchase_lines_validation_and_cost_update() {
    let w = World::new().await;
    let coca = w.product("Coca 330ml", 12000, Some(8000)).await;
    let line = |q: i64, c: i64| json!({"product_id": coca, "quantity": q, "unit_cost": c});
    let mut base = expense(Uuid::now_v7(), 204_000, "nhap_hang");
    base["purchase_lines"] = json!([line(24, 8500)]);
    // amount must equal line sum
    let mut bad = base.clone();
    bad["amount"] = json!(200_000);
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.lead, bad).await.status,
        StatusCode::BAD_REQUEST
    );
    // lines only for nhap_hang
    let mut wrong = base.clone();
    wrong["id"] = json!(Uuid::now_v7());
    wrong["category"] = json!("dien");
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.lead, wrong).await.status,
        StatusCode::BAD_REQUEST
    );
    // unknown product (other store)
    let other = World::new().await;
    let foreign = other.product("Lạ", 1, None).await;
    let mut f = base.clone();
    f["id"] = json!(Uuid::now_v7());
    f["purchase_lines"] = json!([{"product_id": foreign, "quantity": 24, "unit_cost": 8500}]);
    assert_eq!(
        w.call("POST", "/v1/expenses", &w.lead, f).await.status,
        StatusCode::NOT_FOUND
    );
    let cost: Option<i64> = sqlx::query_scalar("SELECT cost_price FROM products WHERE id=$1")
        .bind(coca)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(cost, Some(8000), "rejected requests change nothing");
    // happy: 12000 price, cost 8500 -> margin 29%, no alert at threshold 0
    let e = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            base.clone(),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(e["alerts"].as_array().unwrap().len(), 0);
    let cost: Option<i64> = sqlx::query_scalar("SELECT cost_price FROM products WHERE id=$1")
        .bind(coca)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(cost, Some(8500));
    let hist: (i64, Option<i64>, i64) = sqlx::query_as("SELECT count(*), max(old_value), max(new_value) FROM price_history WHERE product_id=$1 AND field='cost_price' AND source='purchase'").bind(coca).fetch_one(w.pool()).await.unwrap();
    assert_eq!(hist, (1, Some(8000), 8500));
    let base_cost: i64 =
        sqlx::query_scalar("SELECT base_unit_cost FROM purchase_lines WHERE expense_id=$1")
            .bind(base["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(base_cost, 8500);
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.lead,
        base,
        StatusCode::OK,
    )
    .await;
    assert_eq!(w.events("alert.created").await, 0);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn purchase_unit_cost_is_converted_to_base_unit() {
    let w = World::new().await;
    let coca = w.product("Coca", 12000, None).await;
    let unit = Uuid::now_v7();
    sqlx::query("INSERT INTO product_units (id,store_id,product_id,name,quantity_in_base,price) VALUES ($1,$2,$3,'thùng',24,280000)")
        .bind(unit).bind(w.store_id).bind(coca).execute(w.pool()).await.unwrap();
    let mut b = expense(Uuid::now_v7(), 204_000, "nhap_hang");
    b["purchase_lines"] =
        json!([{"product_id": coca, "unit_id": unit, "quantity": 1, "unit_cost": 204_000}]);
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.lead,
        b,
        StatusCode::CREATED,
    )
    .await;
    let cost: Option<i64> = sqlx::query_scalar("SELECT cost_price FROM products WHERE id=$1")
        .bind(coca)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(cost, Some(8500));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn margin_alert_lifecycle_accept_dismiss() {
    let w = World::new().await;
    w.set_margin_threshold(10.0).await;
    let coca = w.product("Coca 330ml", 9000, Some(7000)).await;
    let mut b = expense(Uuid::now_v7(), 204_000, "nhap_hang");
    b["purchase_lines"] = json!([{"product_id": coca, "quantity": 24, "unit_cost": 8500}]);
    let e = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.seller,
            b,
            StatusCode::CREATED,
        )
        .await;
    let alerts = e["alerts"].as_array().unwrap();
    assert_eq!(alerts.len(), 1);
    let a = &alerts[0];
    assert_eq!(a["product_id"], coca.to_string());
    assert_eq!(a["cost_price"], 8500);
    assert_eq!(a["selling_price"], 9000);
    assert_eq!(a["suggested_price"], 10000);
    assert_eq!(a["status"], "open");
    assert!((a["margin_pct"].as_f64().unwrap() - 5.56).abs() < 0.01);
    assert_eq!(w.events("alert.created").await, 1);
    // newer purchase updates the same open alert
    let mut b2 = expense(Uuid::now_v7(), 216_000, "nhap_hang");
    b2["purchase_lines"] = json!([{"product_id": coca, "quantity": 24, "unit_cost": 9000}]);
    let e2 = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            b2,
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(e2["alerts"][0]["id"], a["id"], "one open alert per product");
    assert_eq!(e2["alerts"][0]["suggested_price"], 10000);
    assert_eq!(
        w.events("alert.created").await,
        2,
        "update re-emits alert.created"
    );
    // authz
    assert_eq!(
        w.call("GET", "/v1/alerts", &w.seller, json!(null))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let list = w
        .checked(
            "GET",
            "/v1/alerts",
            "/v1/alerts",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let path = format!("/v1/alerts/{}/accept", a["id"].as_str().unwrap());
    assert_eq!(
        w.call("POST", &path, &w.seller, json!({})).await.status,
        StatusCode::FORBIDDEN
    );
    let other = World::new().await;
    assert_eq!(
        other
            .call("POST", &path, &other.lead, json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        w.call("POST", &path, &w.lead, json!({"new_price": -1}))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let acc = w
        .checked(
            "POST",
            &path,
            "/v1/alerts/{alertId}/accept",
            &w.lead,
            json!({"new_price": 11000}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(acc["status"], "accepted");
    let price: i64 = sqlx::query_scalar("SELECT price FROM products WHERE id=$1")
        .bind(coca)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(price, 11000);
    let h: i64 = sqlx::query_scalar("SELECT count(*) FROM price_history WHERE product_id=$1 AND field='price' AND source='margin_alert' AND new_value=11000").bind(coca).fetch_one(w.pool()).await.unwrap();
    assert_eq!(h, 1);
    assert_eq!(w.events("price.changed").await, 1);
    assert_eq!(w.events("catalog.changed").await, 1);
    assert_eq!(w.events("alert.resolved").await, 1);
    assert_eq!(
        w.call("POST", &path, &w.lead, json!({})).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        w.call("GET", "/v1/alerts", &w.lead, json!(null)).await.body["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        w.call("GET", "/v1/alerts?status=accepted", &w.lead, json!(null))
            .await
            .body["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // dismiss path: new low-margin purchase on another product, accept defaults to suggested
    let tea = w.product("Trà", 5000, Some(1000)).await;
    let mut b3 = expense(Uuid::now_v7(), 4700, "nhap_hang");
    b3["purchase_lines"] = json!([{"product_id": tea, "quantity": 1, "unit_cost": 4700}]);
    let e3 = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            b3,
            StatusCode::CREATED,
        )
        .await;
    let id3 = e3["alerts"][0]["id"].as_str().unwrap();
    let d = w
        .checked(
            "POST",
            &format!("/v1/alerts/{id3}/dismiss"),
            "/v1/alerts/{alertId}/dismiss",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(d["status"], "dismissed");
    assert_eq!(
        w.call(
            "POST",
            &format!("/v1/alerts/{id3}/dismiss"),
            &w.lead,
            json!(null)
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        w.call(
            "POST",
            &format!("/v1/alerts/{id3}/dismiss"),
            &w.seller,
            json!(null)
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn accept_without_body_uses_suggested_price() {
    let w = World::new().await;
    w.set_margin_threshold(10.0).await;
    let p = w.product("Coca", 9000, None).await;
    let mut b = expense(Uuid::now_v7(), 8500, "nhap_hang");
    b["purchase_lines"] = json!([{"product_id": p, "quantity": 1, "unit_cost": 8500}]);
    let e = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            b,
            StatusCode::CREATED,
        )
        .await;
    let id = e["alerts"][0]["id"].as_str().unwrap();
    let a = w
        .checked(
            "POST",
            &format!("/v1/alerts/{id}/accept"),
            "/v1/alerts/{alertId}/accept",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(a["status"], "accepted");
    let price: i64 = sqlx::query_scalar("SELECT price FROM products WHERE id=$1")
        .bind(p)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(price, 10000);
}
