//! Cash reconciliation, cost and margin are Lead-only: sellers get 403 or redacted fields.
mod common;
use axum::http::StatusCode;
use common::world::{World, now_iso, sale_body};
use serde_json::{Value, json};
use uuid::Uuid;

const DAY: &str = "2026-03-05";
const AT: &str = "2026-03-05T10:00:00+07:00";

async fn sell(w: &World, token: &str, product: Uuid) {
    let mut body = sale_body(Uuid::now_v7(), AT, "cash", &[(product, 2, 10000)]);
    body["cash_received"] = body["total"].clone();
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        token,
        body,
        StatusCode::CREATED,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sellers_cannot_read_day_close_cash_figures() {
    let w = World::new().await;
    let p = w.product("Coca", 10000, Some(6000)).await;
    sell(&w, &w.seller, p).await;
    let path = format!("/v1/day-closes/{DAY}");
    let closed = w
        .checked(
            "PUT",
            &path,
            "/v1/day-closes/{businessDate}",
            &w.lead,
            json!({"counted_cash": 19000, "opening_float": 500, "note": "thiếu 1000"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(closed["counted_cash"], 19000);

    // Seller: 403 with a clear message on both reads, and on writing.
    for (method, uri, body) in [
        ("GET", path.as_str(), Value::Null),
        ("GET", "/v1/day-closes", Value::Null),
        ("PUT", path.as_str(), json!({"counted_cash": 1})),
    ] {
        let reply = w.call(method, uri, &w.seller, body).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {uri}");
        assert_eq!(reply.body["code"], "forbidden");
        assert!(
            reply.body["error"]
                .as_str()
                .is_some_and(|m| m.contains("store owner")),
            "{}",
            reply.body
        );
        let text = reply.body.to_string();
        assert!(!text.contains("19000") && !text.contains("thiếu"), "{text}");
    }

    // Seller: reports/today keeps the sales figures but drops expected cash and the close.
    let today = format!("/v1/reports/today?date={DAY}");
    let seen = w
        .checked(
            "GET",
            &today,
            "/v1/reports/today",
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(seen["revenue"], 20000);
    assert_eq!(seen["cash_revenue"], 20000);
    for field in ["expected_cash", "day_close"] {
        assert!(seen.get(field).is_none(), "{field} leaked: {seen}");
    }

    // Lead: everything is still there.
    let one = w
        .checked(
            "GET",
            &path,
            "/v1/day-closes/{businessDate}",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(one["counted_cash"], 19000);
    assert_eq!(one["note"], "thiếu 1000");
    let list = w
        .checked(
            "GET",
            "/v1/day-closes",
            "/v1/day-closes",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let full = w
        .checked(
            "GET",
            &today,
            "/v1/reports/today",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(full["expected_cash"], 20500);
    assert_eq!(full["day_close"]["counted_cash"], 19000);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sellers_get_top_products_without_margin_or_cost() {
    let w = World::new().await;
    let p = w.product("Coca", 10000, Some(7777)).await;
    sell(&w, &w.seller, p).await;
    let uri = format!("/v1/reports/top-products?from={DAY}&to={DAY}");
    let seller = w
        .checked(
            "GET",
            &uri,
            "/v1/reports/top-products",
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    let items = seller["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["revenue"], 20000);
    assert_eq!(items[0]["quantity"], 2);
    assert!(items[0].get("gross_margin").is_none(), "{seller}");
    assert!(!seller.to_string().contains("7777"));
    let lead = w
        .checked(
            "GET",
            &uri,
            "/v1/reports/top-products",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(lead["items"][0]["gross_margin"], 20000 - 2 * 7777);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sellers_do_not_see_purchase_costs_or_margin_alerts_on_expenses() {
    let w = World::new().await;
    w.set_margin_threshold(10.0).await;
    let coca = w.product("Coca 330ml", 9000, Some(7000)).await;
    let id = Uuid::now_v7();
    let body = json!({"id": id, "spent_at": now_iso(), "amount": 204_000, "category": "nhap_hang",
        "paid_with": "cash_box",
        "purchase_lines": [{"product_id": coca, "quantity": 24, "unit_cost": 8500}]});
    let created = w
        .checked(
            "POST",
            "/v1/expenses",
            "/v1/expenses",
            &w.lead,
            body,
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(created["alerts"][0]["cost_price"], 8500);
    assert_eq!(created["purchase_lines"][0]["unit_cost"], 8500);

    let path = format!("/v1/expenses/{id}");
    let seen = w.call("GET", &path, &w.seller, Value::Null).await;
    assert_eq!(seen.status, StatusCode::OK);
    assert_eq!(seen.body["amount"], 204_000);
    assert_eq!(seen.body["alerts"], json!([]));
    assert_eq!(seen.body["purchase_lines"], json!([]));
    let list = w.call("GET", "/v1/expenses", &w.seller, Value::Null).await;
    assert_eq!(list.status, StatusCode::OK);
    let text = list.body.to_string();
    assert!(
        !text.contains("8500") && !text.contains("margin_pct"),
        "{text}"
    );

    // The Lead still sees both.
    let lead = w
        .checked(
            "GET",
            &path,
            "/v1/expenses/{expenseId}",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(lead["alerts"][0]["cost_price"], 8500);
    assert_eq!(lead["purchase_lines"][0]["unit_cost"], 8500);
}
