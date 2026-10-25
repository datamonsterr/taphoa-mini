//! X5 ledger regression suite. Every HTTP response is checked against OpenAPI.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::{Contract, world::World};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const CUSTOMER: &str = "/v1/customers/{customerId}";
async fn create(w: &World, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    w.checked(
        "POST",
        "/v1/customers",
        "/v1/customers",
        &w.seller,
        json!({"id":id,"name":name}),
        StatusCode::CREATED,
    )
    .await;
    id
}
async fn keyed(
    w: &World,
    id: Uuid,
    kind: &str,
    key: Option<&str>,
    body: Value,
    token: &str,
    status: StatusCode,
) -> Value {
    let path = format!("/v1/customers/{id}/{kind}");
    let mut req = Request::post(&path)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"));
    if let Some(key) = key {
        req = req.header("idempotency-key", key);
    }
    let res = w
        .app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let actual = res.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(actual, status, "{path}: {body}");
    Contract::load().assert_conforms(&format!("{CUSTOMER}/{kind}"), "post", status, &body);
    body
}
async fn get(w: &World, id: Uuid) -> Value {
    w.checked(
        "GET",
        &format!("/v1/customers/{id}"),
        CUSTOMER,
        &w.seller,
        Value::Null,
        StatusCode::OK,
    )
    .await
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn customer_create_replay_conflict_patch_archive_and_scope() {
    let w = World::new().await;
    let id = Uuid::now_v7();
    let body = json!({"id":id,"name":"  Private Name  ","phone":"secret-phone","note":"secret-note","credit_limit":100});
    let c = w
        .checked(
            "POST",
            "/v1/customers",
            "/v1/customers",
            &w.seller,
            body.clone(),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(c["name"], "Private Name");
    assert_eq!(c["balance"], 0);
    assert!(c["oldest_debt_date"].is_null());
    let again = w
        .checked(
            "POST",
            "/v1/customers",
            "/v1/customers",
            &w.seller,
            body.clone(),
            StatusCode::OK,
        )
        .await;
    assert_eq!(c, again);
    let mut changed = body;
    changed["name"] = json!("Other");
    let conflict = w
        .checked(
            "POST",
            "/v1/customers",
            "/v1/customers",
            &w.seller,
            changed,
            StatusCode::CONFLICT,
        )
        .await;
    assert_eq!(conflict["code"], "id_conflict");
    let path = format!("/v1/customers/{id}");
    let c = w
        .checked(
            "PATCH",
            &path,
            CUSTOMER,
            &w.seller,
            json!({"phone":null,"note":null,"credit_limit":null}),
            StatusCode::OK,
        )
        .await;
    assert!(c["phone"].is_null() && c["note"].is_null() && c["credit_limit"].is_null());
    w.checked(
        "PATCH",
        &path,
        CUSTOMER,
        &w.seller,
        json!({"archived":true}),
        StatusCode::FORBIDDEN,
    )
    .await;
    let c = w
        .checked(
            "PATCH",
            &path,
            CUSTOMER,
            &w.lead,
            json!({"archived":true}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(c["archived"], true);
    keyed(
        &w,
        id,
        "repayments",
        Some("archived"),
        json!({"amount":5,"method":"cash"}),
        &w.seller,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(get(&w, id).await["balance"], -5);
    let other = World::new().await;
    other
        .checked(
            "GET",
            &path,
            CUSTOMER,
            &other.lead,
            Value::Null,
            StatusCode::NOT_FOUND,
        )
        .await;
    other
        .checked(
            "PATCH",
            &path,
            CUSTOMER,
            &other.lead,
            json!({"name":"Foreign"}),
            StatusCode::NOT_FOUND,
        )
        .await;
    assert_eq!(w.events("customer.created").await, 1);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn repayment_adjustment_idempotency_validation_and_concurrency() {
    let w = World::new().await;
    let id = create(&w, "Debtor").await;
    keyed(
        &w,
        id,
        "adjustments",
        Some("seller"),
        json!({"amount":100,"reason":"opening"}),
        &w.seller,
        StatusCode::FORBIDDEN,
    )
    .await;
    let opening = keyed(
        &w,
        id,
        "adjustments",
        Some("opening"),
        json!({"amount":100,"reason":"opening"}),
        &w.lead,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(opening["balance_after"], 100);
    let body = json!({"amount":10,"method":"cash"});
    let entry = keyed(
        &w,
        id,
        "repayments",
        Some("pay"),
        body.clone(),
        &w.seller,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(entry["amount"], -10);
    assert_eq!(entry["balance_after"], 90);
    assert_eq!(
        entry,
        keyed(
            &w,
            id,
            "repayments",
            Some("pay"),
            body,
            &w.seller,
            StatusCode::OK
        )
        .await
    );
    let conflict = keyed(
        &w,
        id,
        "repayments",
        Some("pay"),
        json!({"amount":11,"method":"cash"}),
        &w.seller,
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(conflict["code"], "id_conflict");
    let second = create(&w, "Other").await;
    keyed(
        &w,
        second,
        "repayments",
        Some("pay"),
        json!({"amount":10,"method":"cash"}),
        &w.seller,
        StatusCode::CONFLICT,
    )
    .await;
    keyed(
        &w,
        id,
        "adjustments",
        Some("pay"),
        json!({"amount":10,"reason":"other kind"}),
        &w.lead,
        StatusCode::CONFLICT,
    )
    .await;
    for body in [
        json!({"amount":0,"method":"cash"}),
        json!({"amount":-1,"method":"cash"}),
        json!({"amount":1,"method":"card"}),
        json!({"amount":1,"method":"cash","paid_at":"bad"}),
        json!({}),
    ] {
        let invalid = keyed(
            &w,
            id,
            "repayments",
            Some("bad"),
            body,
            &w.seller,
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
        assert_eq!(invalid["code"], "invalid");
    }
    keyed(
        &w,
        id,
        "repayments",
        None,
        json!({"amount":1,"method":"cash"}),
        &w.seller,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    for body in [
        json!({"amount":0,"reason":"x"}),
        json!({"amount":1,"reason":""}),
        json!({"amount":1,"reason":"x".repeat(201)}),
    ] {
        keyed(
            &w,
            id,
            "adjustments",
            Some("bad"),
            body,
            &w.lead,
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
    }
    let tasks = (0..20).map(|i| {
        keyed(
            &w,
            id,
            "repayments",
            Some(Box::leak(format!("parallel-{i}").into_boxed_str())),
            json!({"amount":7,"method":"transfer"}),
            &w.seller,
            StatusCode::CREATED,
        )
    });
    let rows = futures_util::future::join_all(tasks).await;
    let mut balances: Vec<_> = rows
        .iter()
        .map(|r| r["balance_after"].as_i64().unwrap())
        .collect();
    balances.sort();
    balances.dedup();
    assert_eq!(balances.len(), 20);
    assert_eq!(get(&w, id).await["balance"], -50);
    assert!(get(&w, id).await["oldest_debt_date"].is_null());
    let page = w
        .checked(
            "GET",
            &format!("/v1/customers/{id}/entries?limit=1"),
            &format!("{CUSTOMER}/entries"),
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let next = w
        .checked(
            "GET",
            &format!(
                "/v1/customers/{id}/entries?limit=1&cursor={}",
                page["next_cursor"].as_str().unwrap()
            ),
            &format!("{CUSTOMER}/entries"),
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    assert_eq!(w.events("debt.repaid").await, 21);
    assert_eq!(w.events("debt.adjusted").await, 1);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn search_aging_sort_pagination_summary_feed_and_private_events() {
    let w = World::new().await;
    let a = create(&w, "Alpha Private").await;
    let b = create(&w, "Beta").await;
    let old = (chrono::Utc::now() - chrono::Duration::days(10)).to_rfc3339();
    keyed(
        &w,
        a,
        "adjustments",
        Some("a"),
        json!({"amount":100,"reason":"opening","adjusted_at":old}),
        &w.lead,
        StatusCode::CREATED,
    )
    .await;
    keyed(
        &w,
        b,
        "adjustments",
        Some("b"),
        json!({"amount":200,"reason":"opening"}),
        &w.lead,
        StatusCode::CREATED,
    )
    .await;
    let c = get(&w, a).await;
    assert_eq!(c["overdue"], true);
    assert_eq!(c["debt_age_days"], 10);
    w.checked(
        "PATCH",
        &format!("/v1/customers/{a}"),
        CUSTOMER,
        &w.seller,
        json!({"phone":"UniquePhone","note":"PrivateNote"}),
        StatusCode::OK,
    )
    .await;
    for query in ["query=ALPHA", "query=uniquephone", "overdue=true"] {
        let list = w
            .checked(
                "GET",
                &format!("/v1/customers?{query}"),
                "/v1/customers",
                &w.seller,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        assert_eq!(list["items"].as_array().unwrap().len(), 1);
        assert_eq!(list["items"][0]["id"], a.to_string());
    }
    for (sort, first) in [("name", a), ("balance", b), ("recent", a)] {
        let page = w
            .checked(
                "GET",
                &format!("/v1/customers?sort={sort}&limit=1"),
                "/v1/customers",
                &w.seller,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        assert_eq!(page["items"][0]["id"], first.to_string());
        let next = w
            .checked(
                "GET",
                &format!(
                    "/v1/customers?sort={sort}&limit=1&cursor={}",
                    page["next_cursor"].as_str().unwrap()
                ),
                "/v1/customers",
                &w.seller,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
        assert!(next["next_cursor"].is_null());
    }
    let summary = w
        .checked(
            "GET",
            "/v1/debts/summary",
            "/v1/debts/summary",
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(summary["total_outstanding"], 300);
    assert_eq!(summary["customers_with_debt"], 2);
    assert_eq!(summary["overdue_count"], 1);
    assert_eq!(summary["overdue_amount"], 100);
    assert_eq!(summary["top_debtors"][0]["id"], b.to_string());
    let feed = w
        .checked(
            "GET",
            "/v1/sync/changes",
            "/v1/sync/changes",
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    let changes = feed["changes"].as_array().unwrap();
    let customer = changes
        .iter()
        .find(|c| c["entity"] == "customer" && c["id"] == a.to_string())
        .unwrap();
    assert_eq!(customer["op"], "upsert");
    assert_eq!(customer["data"], get(&w, a).await);
    let entries = w
        .checked(
            "GET",
            &format!("/v1/customers/{a}/entries"),
            &format!("{CUSTOMER}/entries"),
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    let change = changes
        .iter()
        .find(|c| c["entity"] == "debt_entry" && c["data"]["customer_id"] == a.to_string())
        .unwrap();
    assert_eq!(change["data"], entries["items"][0]);
    let payloads:Vec<Value>=sqlx::query_scalar("SELECT payload FROM outbox_events WHERE store_id=$1 AND (type LIKE 'customer.%' OR type LIKE 'debt.%')").bind(w.store_id).fetch_all(w.pool()).await.unwrap();
    for payload in payloads {
        let text = payload.to_string();
        for private in [
            "Alpha Private",
            "UniquePhone",
            "PrivateNote",
            "name",
            "phone",
            "note",
        ] {
            assert!(!text.contains(private), "{text}");
        }
    }
    w.checked(
        "PATCH",
        &format!("/v1/customers/{a}"),
        CUSTOMER,
        &w.lead,
        json!({"archived":true}),
        StatusCode::OK,
    )
    .await;
    for (query, count) in [("", 1), ("?archived=true", 1)] {
        let list = w
            .checked(
                "GET",
                &format!("/v1/customers{query}"),
                "/v1/customers",
                &w.seller,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        assert_eq!(list["items"].as_array().unwrap().len(), count);
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn customer_input_validation() {
    let w = World::new().await;
    for fields in [
        json!({"name":" "}),
        json!({"name":"x".repeat(81)}),
        json!({"name":"x","phone":"x".repeat(21)}),
        json!({"name":"x","note":"x".repeat(201)}),
        json!({"name":"x","credit_limit":-1}),
    ] {
        let mut body = fields;
        body["id"] = json!(Uuid::now_v7());
        w.checked(
            "POST",
            "/v1/customers",
            "/v1/customers",
            &w.seller,
            body,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
}
