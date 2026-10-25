//! X5 ledger regression suite. Every HTTP response is checked against OpenAPI.
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
        json!({"amount":1,"method":"cash","paid_at":null}),
        json!([1, "cash"]),
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
        assert_eq!(invalid["code"], "validation_failed");
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
        json!({"amount":1,"reason":"x","adjusted_at":null}),
        json!([1, "reason"]),
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
    let keys: Vec<_> = (0..20).map(|i| format!("parallel-{i}")).collect();
    let tasks = keys.iter().map(|key| {
        keyed(
            &w,
            id,
            "repayments",
            Some(key),
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
    w.checked(
        "POST",
        "/v1/customers",
        "/v1/customers",
        &w.seller,
        json!([Uuid::now_v7(), "Array Name", null, null, null]),
        StatusCode::BAD_REQUEST,
    )
    .await;
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
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn malformed_customer_id_is_a_json_not_found() {
    let w = World::new().await;
    let id = create(&w, "Real").await;
    for (method, path, token, body) in [
        ("GET", "/v1/customers/not-a-uuid", &w.seller, Value::Null),
        (
            "PATCH",
            "/v1/customers/not-a-uuid",
            &w.seller,
            json!({"name":"x"}),
        ),
        (
            "GET",
            "/v1/customers/not-a-uuid/entries",
            &w.seller,
            Value::Null,
        ),
        (
            "POST",
            "/v1/customers/not-a-uuid/repayments",
            &w.seller,
            json!({"amount":1,"method":"cash"}),
        ),
        (
            "POST",
            "/v1/customers/not-a-uuid/adjustments",
            &w.lead,
            json!({"amount":1,"reason":"x"}),
        ),
    ] {
        let reply = w.call(method, path, token, body).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{method} {path}");
        assert_eq!(reply.body["code"], "not_found", "{method} {path}");
        assert!(
            reply
                .headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json")),
            "{method} {path}: {:?}",
            reply.headers
        );
    }
    // A well-formed id still works.
    get(&w, id).await;
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sale_customer_reference_is_store_scoped_and_sale_entries_are_unique() {
    let a = World::new().await;
    let b = World::new().await;
    let customer = create(&a, "Scoped").await;
    let insert = |w: &World, sale: Uuid, customer: Uuid| {
        let pool = w.pool().clone();
        let (store, member) = (w.store_id, w.lead_id);
        async move {
            sqlx::query("INSERT INTO sales(id,store_id,code,member_id,sold_at,business_date,payment_method,total,credit_amount,customer_id,request_hash) VALUES($1,$2,'FK',$3,now(),current_date,'credit',100,100,$4,'\\x00')")
                .bind(sale).bind(store).bind(member).bind(customer).execute(&pool).await
        }
    };
    // Store B cannot point a sale at store A's customer.
    let foreign = insert(&b, Uuid::now_v7(), customer).await.unwrap_err();
    assert!(
        foreign
            .as_database_error()
            .is_some_and(|e| e.is_foreign_key_violation()),
        "{foreign}"
    );
    let sale = Uuid::now_v7();
    insert(&a, sale, customer).await.unwrap();
    let entry = |kind: &'static str, amount: i64| {
        let pool = a.pool().clone();
        let (store, member) = (a.store_id, a.lead_id);
        async move {
            sqlx::query("INSERT INTO debt_entries(store_id,customer_id,kind,amount,balance_after,sale_id,member_id,business_date) VALUES($1,$2,$3,$4,$4,$5,$6,current_date)")
                .bind(store).bind(customer).bind(kind).bind(amount).bind(sale).bind(member).execute(&pool).await
        }
    };
    let is_unique = |r: Result<sqlx::postgres::PgQueryResult, sqlx::Error>| {
        r.unwrap_err()
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
    };
    entry("credit_sale", 100).await.unwrap();
    assert!(is_unique(entry("credit_sale", 100).await));
    entry("void", -100).await.unwrap();
    assert!(is_unique(entry("void", -100).await));
}

// ---------------------------------------------------------------------------------------------
// T2b: credit sales, void reversal and day close
// ---------------------------------------------------------------------------------------------
const SALES: &str = "/v1/sales";
const SALE: &str = "/v1/sales/{saleId}";
const VOID: &str = "/v1/sales/{saleId}/void";
const DAY_CLOSE: &str = "/v1/day-closes/{businessDate}";
const PRICE: i64 = 30_000;

/// A one-line sale for `PRICE`, with a `credit` object unless `credit` is `None`.
async fn credit_body(
    w: &World,
    customer: Uuid,
    method: &str,
    credit: Option<i64>,
    cash_received: Option<i64>,
    at: &str,
) -> Value {
    let product = w.product("Hàng ghi nợ", PRICE, None).await;
    let mut body = sale_body(Uuid::now_v7(), at, method, &[(product, 1, PRICE)]);
    if let Some(amount) = credit {
        body["credit"] = json!({"customer_id": customer, "amount": amount});
    }
    if let Some(cash) = cash_received {
        body["cash_received"] = json!(cash);
    }
    body
}
async fn post_sale(w: &World, token: &str, body: Value, status: StatusCode) -> Value {
    w.checked("POST", SALES, SALES, token, body, status).await
}
async fn sale_exists(w: &World, id: &Value) -> bool {
    let path = format!("/v1/sales/{}", id.as_str().unwrap());
    w.call("GET", &path, &w.seller, Value::Null).await.status == StatusCode::OK
}
async fn entries_of(w: &World, customer: Uuid) -> Vec<Value> {
    w.checked(
        "GET",
        &format!("/v1/customers/{customer}/entries"),
        &format!("{CUSTOMER}/entries"),
        &w.seller,
        Value::Null,
        StatusCode::OK,
    )
    .await["items"]
        .as_array()
        .unwrap()
        .clone()
}
async fn payloads(w: &World, typ: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE store_id=$1 AND type=$2 ORDER BY id",
    )
    .bind(w.store_id)
    .bind(typ)
    .fetch_all(w.pool())
    .await
    .unwrap()
}
fn assert_event_contract(payload: &Value) {
    let doc: Value =
        serde_norway::from_str(include_str!("../../../../../docs/api/asyncapi.yaml")).unwrap();
    let message = doc["components"]["messages"]
        .as_object()
        .unwrap()
        .values()
        .find(|m| m["name"] == payload["type"])
        .unwrap();
    let root = json!({"$schema":"https://json-schema.org/draft/2020-12/schema","components":doc["components"],"allOf":[message["payload"]]});
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&root)
        .unwrap();
    let errors: Vec<_> = validator
        .iter_errors(payload)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{payload}: {errors:?}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn full_credit_sale_records_one_entry_balance_feed_and_events() {
    let w = World::new().await;
    let customer = create(&w, "Chị Lan").await;
    let body = credit_body(&w, customer, "credit", Some(PRICE), None, &now_iso()).await;
    let sale = post_sale(&w, &w.seller, body.clone(), StatusCode::CREATED).await;
    assert_eq!(sale["payment_method"], "credit");
    assert_eq!(sale["total"], PRICE);
    assert_eq!(sale["credit_amount"], PRICE);
    assert_eq!(sale["customer_id"], customer.to_string());
    assert!(sale["cash_received"].is_null() && sale["change_given"].is_null());
    let c = get(&w, customer).await;
    assert_eq!(c["balance"], PRICE);
    assert_eq!(c["oldest_debt_date"], sale["business_date"]);
    let items = entries_of(&w, customer).await;
    assert_eq!(items.len(), 1);
    let entry = &items[0];
    assert_eq!(entry["kind"], "credit_sale");
    assert_eq!(entry["amount"], PRICE);
    assert_eq!(entry["balance_after"], PRICE);
    assert_eq!(entry["sale_id"], sale["id"]);
    assert_eq!(entry["member_id"], w.seller_id.to_string());
    assert_eq!(entry["business_date"], sale["business_date"]);
    // The stored sale reads back the same, and the credit method filter finds it.
    let stored = w
        .checked(
            "GET",
            &format!("/v1/sales/{}", sale["id"].as_str().unwrap()),
            SALE,
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(stored, sale);
    let listed = w
        .checked(
            "GET",
            "/v1/sales?payment_method=credit",
            SALES,
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["id"], sale["id"]);
    // The change feed carries the entry and the new customer balance.
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
    let change = changes
        .iter()
        .find(|c| c["entity"] == "debt_entry" && c["id"] == entry["id"])
        .expect("debt_entry in the feed");
    assert_eq!(change["data"], *entry);
    let feed_customer = changes
        .iter()
        .rev()
        .find(|c| c["entity"] == "customer" && c["id"] == customer.to_string())
        .expect("customer in the feed");
    assert_eq!(feed_customer["data"]["balance"], PRICE);
    // Events: sale.created gains credit fields, debt.recorded follows, neither names the customer.
    let created = payloads(&w, "sale.created").await;
    assert_eq!(created.len(), 1);
    assert_event_contract(&created[0]);
    assert_eq!(created[0]["data"]["credit_amount"], PRICE);
    assert_eq!(created[0]["data"]["customer_id"], customer.to_string());
    let recorded = payloads(&w, "debt.recorded").await;
    assert_eq!(recorded.len(), 1);
    assert_event_contract(&recorded[0]);
    assert_eq!(recorded[0]["data"]["kind"], "credit_sale");
    assert_eq!(recorded[0]["data"]["sale_id"], sale["id"]);
    assert_eq!(recorded[0]["data"]["balance"], PRICE);
    assert!(!created[0].to_string().contains("Chị Lan"));
    // Replay of the same sale id creates no second entry, event or balance change.
    let again = post_sale(&w, &w.seller, body.clone(), StatusCode::OK).await;
    assert_eq!(again, sale);
    assert_eq!(entries_of(&w, customer).await.len(), 1);
    assert_eq!(get(&w, customer).await["balance"], PRICE);
    assert_eq!(w.events("debt.recorded").await, 1);
    assert_eq!(w.events("sale.created").await, 1);
    // A different body under the same id is a conflict and changes nothing.
    let mut changed = body;
    changed["credit"]["amount"] = json!(PRICE - 1);
    let conflict = w.call("POST", SALES, &w.seller, changed).await;
    assert_eq!(conflict.status, StatusCode::CONFLICT);
    assert_eq!(conflict.body["code"], "id_conflict");
    assert_eq!(get(&w, customer).await["balance"], PRICE);
    // A sale without credit still reports zero credit and no customer.
    let product = w.product("Tiền mặt", 5_000, None).await;
    let mut cash = sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(product, 1, 5_000)]);
    cash["cash_received"] = json!(5_000);
    let plain = post_sale(&w, &w.seller, cash, StatusCode::CREATED).await;
    assert_eq!(plain["credit_amount"], 0);
    assert!(plain["customer_id"].is_null());
    let created = payloads(&w, "sale.created").await;
    assert_eq!(created[1]["data"]["credit_amount"], 0);
    assert!(created[1]["data"]["customer_id"].is_null());
    assert_event_contract(&created[1]);
    assert_eq!(w.events("debt.recorded").await, 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn partial_cash_credit_sale_change_uses_the_paid_part() {
    let w = World::new().await;
    let customer = create(&w, "Partial cash").await;
    // total 30000, credit 12000: the customer pays 18000 now.
    let body = credit_body(&w, customer, "cash", Some(12_000), Some(20_000), &now_iso()).await;
    let sale = post_sale(&w, &w.seller, body, StatusCode::CREATED).await;
    assert_eq!(sale["payment_method"], "cash");
    assert_eq!(sale["credit_amount"], 12_000);
    assert_eq!(sale["customer_id"], customer.to_string());
    assert_eq!(sale["cash_received"], 20_000);
    assert_eq!(sale["change_given"], 2_000);
    let stored = w
        .checked(
            "GET",
            &format!("/v1/sales/{}", sale["id"].as_str().unwrap()),
            SALE,
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(stored["change_given"], 2_000);
    assert_eq!(get(&w, customer).await["balance"], 12_000);
    let entry = &entries_of(&w, customer).await[0];
    assert_eq!(entry["amount"], 12_000);
    // Exactly the paid part: no change.
    let exact = credit_body(&w, customer, "cash", Some(12_000), Some(18_000), &now_iso()).await;
    let exact = post_sale(&w, &w.seller, exact, StatusCode::CREATED).await;
    assert_eq!(exact["change_given"], 0);
    // One dong short is rejected and leaves no sale or entry behind.
    let short = credit_body(&w, customer, "cash", Some(12_000), Some(17_999), &now_iso()).await;
    let id = short["id"].clone();
    let reply = w.call("POST", SALES, &w.seller, short).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "validation_failed");
    assert!(!sale_exists(&w, &id).await);
    // Without cash_received the paid part is simply not tracked.
    let open = credit_body(&w, customer, "cash", Some(12_000), None, &now_iso()).await;
    let open = post_sale(&w, &w.seller, open, StatusCode::CREATED).await;
    assert!(open["cash_received"].is_null() && open["change_given"].is_null());
    assert_eq!(get(&w, customer).await["balance"], 36_000);
    assert_eq!(entries_of(&w, customer).await.len(), 3);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn partial_transfer_credit_sale() {
    let w = World::new().await;
    let customer = create(&w, "Partial transfer").await;
    let body = credit_body(&w, customer, "transfer", Some(10_000), None, &now_iso()).await;
    let sale = post_sale(&w, &w.seller, body, StatusCode::CREATED).await;
    assert_eq!(sale["payment_method"], "transfer");
    assert_eq!(sale["credit_amount"], 10_000);
    assert_eq!(sale["customer_id"], customer.to_string());
    assert!(sale["cash_received"].is_null() && sale["change_given"].is_null());
    assert_eq!(get(&w, customer).await["balance"], 10_000);
    let entry = &entries_of(&w, customer).await[0];
    assert_eq!(entry["kind"], "credit_sale");
    assert_eq!(entry["amount"], 10_000);
    assert_eq!(entry["sale_id"], sale["id"]);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn invalid_credit_combinations_unknown_and_foreign_customers() {
    let w = World::new().await;
    let customer = create(&w, "Validation").await;
    // (method, credit.amount, cash_received) for a 30000 sale.
    for (method, credit, cash) in [
        ("credit", None, None),
        ("credit", Some(PRICE - 1), None),
        ("credit", Some(PRICE + 1), None),
        ("credit", Some(0), None),
        ("credit", Some(PRICE), Some(PRICE)),
        ("cash", Some(PRICE), Some(PRICE)),
        ("cash", Some(PRICE + 1), None),
        ("cash", Some(0), None),
        ("cash", Some(-1), None),
        ("cash", Some(10_000), Some(19_999)),
        ("transfer", Some(PRICE), None),
        ("transfer", Some(0), None),
        ("transfer", Some(10_000), Some(PRICE)),
    ] {
        let body = credit_body(&w, customer, method, credit, cash, &now_iso()).await;
        let id = body["id"].clone();
        let reply = w.call("POST", SALES, &w.seller, body).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{method} {credit:?} {cash:?}: {}",
            reply.body
        );
        assert_eq!(reply.body["code"], "validation_failed");
        assert!(!sale_exists(&w, &id).await, "{method} {credit:?} {cash:?}");
    }
    let mut malformed = credit_body(&w, customer, "credit", Some(PRICE), None, &now_iso()).await;
    malformed["credit"]["customer_id"] = json!("not-a-uuid");
    let reply = w.call("POST", SALES, &w.seller, malformed).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "validation_failed");
    assert_eq!(get(&w, customer).await["balance"], 0);
    assert!(entries_of(&w, customer).await.is_empty());
    // Unknown customer: 404, and the sale is rolled back.
    let body = credit_body(&w, Uuid::now_v7(), "credit", Some(PRICE), None, &now_iso()).await;
    let id = body["id"].clone();
    let reply = w.call("POST", SALES, &w.seller, body).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
    assert_eq!(reply.body["code"], "not_found");
    assert!(!sale_exists(&w, &id).await);
    // Another store's customer is just as unknown.
    let other = World::new().await;
    let foreign = create(&other, "Foreign").await;
    let body = credit_body(&w, foreign, "cash", Some(10_000), Some(20_000), &now_iso()).await;
    let id = body["id"].clone();
    let reply = w.call("POST", SALES, &w.seller, body).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
    assert!(!sale_exists(&w, &id).await);
    let untouched = other
        .checked(
            "GET",
            &format!("/v1/customers/{foreign}"),
            CUSTOMER,
            &other.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(untouched["balance"], 0);
    assert_eq!(w.events("debt.recorded").await, 0);
    // Archived customers still accept credit sales, and a credit limit never blocks.
    w.checked(
        "PATCH",
        &format!("/v1/customers/{customer}"),
        CUSTOMER,
        &w.lead,
        json!({"archived":true,"credit_limit":1}),
        StatusCode::OK,
    )
    .await;
    let body = credit_body(&w, customer, "credit", Some(PRICE), None, &now_iso()).await;
    post_sale(&w, &w.seller, body, StatusCode::CREATED).await;
    let c = get(&w, customer).await;
    assert_eq!(c["balance"], PRICE);
    assert_eq!(c["archived"], true);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn void_reverses_the_credit_once_and_leaves_aging() {
    let w = World::new().await;
    let customer = create(&w, "Void me").await;
    keyed(
        &w,
        customer,
        "adjustments",
        Some("opening"),
        json!({"amount":50,"reason":"opening"}),
        &w.lead,
        StatusCode::CREATED,
    )
    .await;
    // A credit from ten days ago makes the customer overdue.
    let old = (chrono::Utc::now() - chrono::Duration::days(10)).to_rfc3339();
    let body = credit_body(&w, customer, "credit", Some(PRICE), None, &old).await;
    let sale = post_sale(&w, &w.seller, body, StatusCode::CREATED).await;
    let id = sale["id"].as_str().unwrap();
    let c = get(&w, customer).await;
    assert_eq!(c["balance"], PRICE + 50);
    assert_eq!(c["debt_age_days"], 10);
    assert_eq!(c["overdue"], true);
    // A plain cash sale voided later adds no ledger entry.
    let product = w.product("Tiền mặt", 5_000, None).await;
    let mut cash = sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(product, 1, 5_000)]);
    cash["cash_received"] = json!(5_000);
    let cash = post_sale(&w, &w.seller, cash, StatusCode::CREATED).await;
    let path = format!("/v1/sales/{}/void", cash["id"].as_str().unwrap());
    w.checked(
        "POST",
        &path,
        VOID,
        &w.lead,
        json!({"reason":"trả hàng"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(entries_of(&w, customer).await.len(), 2);
    assert_eq!(w.events("debt.recorded").await, 1);
    // Voiding the credit sale reverses exactly its credit on the void's business date.
    let path = format!("/v1/sales/{id}/void");
    let voided = w
        .checked(
            "POST",
            &path,
            VOID,
            &w.lead,
            json!({"reason":"khách trả hàng","voided_at":"2026-03-06T09:00:00+07:00"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(voided["status"], "voided");
    assert_eq!(voided["credit_amount"], PRICE);
    let entries = entries_of(&w, customer).await;
    assert_eq!(entries.len(), 3);
    let void = entries.iter().find(|e| e["kind"] == "void").unwrap();
    assert_eq!(void["amount"], -PRICE);
    assert_eq!(void["sale_id"], id);
    assert_eq!(void["business_date"], "2026-03-06");
    assert_eq!(void["balance_after"], 50);
    assert_eq!(void["member_id"], w.lead_id.to_string());
    let opening = entries.iter().find(|e| e["kind"] == "adjustment").unwrap();
    // The credit/void pair is out of aging: only the opening adjustment is left.
    let c = get(&w, customer).await;
    assert_eq!(c["balance"], 50);
    assert_eq!(c["oldest_debt_date"], opening["business_date"]);
    assert_eq!(c["overdue"], false);
    assert_eq!(c["debt_age_days"], 0);
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
    assert_eq!(summary["total_outstanding"], 50);
    assert_eq!(summary["overdue_count"], 0);
    let recorded = payloads(&w, "debt.recorded").await;
    assert_eq!(recorded.len(), 2);
    assert_event_contract(&recorded[1]);
    assert_eq!(recorded[1]["data"]["kind"], "void");
    assert_eq!(recorded[1]["data"]["amount"], -PRICE);
    // A repeated void is idempotent and adds nothing.
    let again = w
        .checked(
            "POST",
            &path,
            VOID,
            &w.lead,
            json!({"reason":"khách trả hàng"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(again["status"], "voided");
    assert_eq!(entries_of(&w, customer).await.len(), 3);
    assert_eq!(get(&w, customer).await["balance"], 50);
    assert_eq!(w.events("debt.recorded").await, 2);
    assert_eq!(w.events("sale.voided").await, 2);
    // A void after a repayment may leave the store holding the customer's money.
    let body = credit_body(&w, customer, "credit", Some(PRICE), None, &now_iso()).await;
    let second = post_sale(&w, &w.seller, body, StatusCode::CREATED).await;
    keyed(
        &w,
        customer,
        "repayments",
        Some("repay-then-void"),
        json!({"amount":PRICE,"method":"cash"}),
        &w.seller,
        StatusCode::CREATED,
    )
    .await;
    w.checked(
        "POST",
        &format!("/v1/sales/{}/void", second["id"].as_str().unwrap()),
        VOID,
        &w.seller,
        json!({"reason":"nhầm"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(get(&w, customer).await["balance"], 50 - PRICE);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn day_close_expected_cash_with_repayments_and_credit() {
    const DAY: &str = "2026-03-05";
    const AT: &str = "2026-03-05T10:00:00+07:00";
    const NEXT: &str = "2026-03-06T10:00:00+07:00";
    let w = World::new().await;
    let customer = create(&w, "Day close").await;
    // 1. Plain cash sale 20000.
    let product = w.product("Tiền mặt", 10_000, None).await;
    let mut cash = sale_body(Uuid::now_v7(), AT, "cash", &[(product, 2, 10_000)]);
    cash["cash_received"] = json!(20_000);
    post_sale(&w, &w.seller, cash, StatusCode::CREATED).await;
    // 2. Cash sale 30000 with 12000 on credit: 18000 enters the drawer.
    let partial = credit_body(&w, customer, "cash", Some(12_000), Some(20_000), AT).await;
    let partial = post_sale(&w, &w.seller, partial, StatusCode::CREATED).await;
    // 3. Full credit sale 50000.
    let product = w.product("Hàng lớn", 50_000, None).await;
    let mut full = sale_body(Uuid::now_v7(), AT, "credit", &[(product, 1, 50_000)]);
    full["credit"] = json!({"customer_id":customer,"amount":50_000});
    post_sale(&w, &w.seller, full, StatusCode::CREATED).await;
    // 4. Transfer sale 40000 with 15000 on credit: 25000 is transfer revenue.
    let product = w.product("Chuyển khoản", 40_000, None).await;
    let mut transfer = sale_body(Uuid::now_v7(), AT, "transfer", &[(product, 1, 40_000)]);
    transfer["credit"] = json!({"customer_id":customer,"amount":15_000});
    post_sale(&w, &w.seller, transfer, StatusCode::CREATED).await;
    // 5. Repayments of that business date, plus one the next day that must not count.
    for (key, amount, method, at) in [
        ("cash-day", 7_000, "cash", AT),
        ("transfer-day", 4_000, "transfer", AT),
        ("cash-next-day", 3_000, "cash", NEXT),
    ] {
        keyed(
            &w,
            customer,
            "repayments",
            Some(key),
            json!({"amount":amount,"method":method,"paid_at":at}),
            &w.seller,
            StatusCode::CREATED,
        )
        .await;
    }
    // 6. Cash-box expense 5000.
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.lead,
        json!({"id":Uuid::now_v7(),"spent_at":AT,"amount":5_000,"category":"khac","paid_with":"cash_box"}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        get(&w, customer).await["balance"],
        12_000 + 50_000 + 15_000 - 14_000
    );
    let path = format!("/v1/day-closes/{DAY}");
    let close = w
        .checked(
            "PUT",
            &path,
            DAY_CLOSE,
            &w.lead,
            json!({"counted_cash":130_000,"opening_float":100_000}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(close["opening_float"], 100_000);
    assert_eq!(close["cash_sales"], 20_000 + 18_000);
    assert_eq!(close["cash_refunds"], 0);
    assert_eq!(close["cash_repayments"], 7_000);
    assert_eq!(close["transfer_repayments"], 4_000);
    assert_eq!(close["credit_sales"], 12_000 + 50_000 + 15_000);
    assert_eq!(close["cash_expenses"], 5_000);
    assert_eq!(close["transfer_revenue"], 25_000);
    // 100000 + 38000 - 0 + 7000 - 5000
    assert_eq!(close["expected_cash"], 140_000);
    assert_eq!(close["difference"], 130_000 - 140_000);
    // Today's report: revenue is the full totals, the cash and transfer parts only what was paid.
    let report = w
        .checked(
            "GET",
            &format!("/v1/reports/today?date={DAY}"),
            "/v1/reports/today",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(report["revenue"], 20_000 + 30_000 + 50_000 + 40_000);
    assert_eq!(report["cash_revenue"], 38_000);
    assert_eq!(report["transfer_revenue"], 25_000);
    assert_eq!(report["expected_cash"], 140_000);
    assert_eq!(report["day_close"]["cash_repayments"], 7_000);
    assert_eq!(report["day_close"]["credit_sales"], 77_000);
    // Voiding the partial credit sale refunds only the cash that was paid and drops its credit.
    w.checked(
        "POST",
        &format!("/v1/sales/{}/void", partial["id"].as_str().unwrap()),
        VOID,
        &w.lead,
        json!({"reason":"trả hàng"}),
        StatusCode::OK,
    )
    .await;
    let close = w
        .checked(
            "PUT",
            &path,
            DAY_CLOSE,
            &w.lead,
            json!({"counted_cash":122_000,"opening_float":100_000}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(close["cash_sales"], 38_000);
    assert_eq!(close["cash_refunds"], 18_000);
    assert_eq!(close["cash_repayments"], 7_000);
    assert_eq!(close["transfer_repayments"], 4_000);
    assert_eq!(close["credit_sales"], 50_000 + 15_000);
    assert_eq!(close["transfer_revenue"], 25_000);
    // 100000 + 38000 - 18000 + 7000 - 5000
    assert_eq!(close["expected_cash"], 122_000);
    assert_eq!(close["difference"], 0);
    let stored = w
        .checked(
            "GET",
            &path,
            DAY_CLOSE,
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(stored["expected_cash"], 122_000);
    assert_eq!(stored["credit_sales"], 65_000);
    let report = w
        .checked(
            "GET",
            &format!("/v1/reports/today?date={DAY}"),
            "/v1/reports/today",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(report["revenue"], 20_000 + 50_000 + 40_000);
    assert_eq!(report["expected_cash"], 122_000);
    // The next day's close sees only its own repayment.
    let next = w
        .checked(
            "PUT",
            "/v1/day-closes/2026-03-06",
            DAY_CLOSE,
            &w.lead,
            json!({"counted_cash":3_000}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(next["cash_repayments"], 3_000);
    assert_eq!(next["transfer_repayments"], 0);
    assert_eq!(next["credit_sales"], 0);
    assert_eq!(next["expected_cash"], 3_000);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn parallel_credit_sales_serialize_on_the_customer() {
    let w = World::new().await;
    let customer = create(&w, "Parallel").await;
    // Distinct products, so only the customer row can serialize these sales.
    let mut bodies = Vec::new();
    for _ in 0..10 {
        bodies.push(credit_body(&w, customer, "credit", Some(PRICE), None, &now_iso()).await);
    }
    let replies = futures_util::future::join_all(
        bodies
            .iter()
            .map(|body| w.call("POST", SALES, &w.seller, body.clone())),
    )
    .await;
    for reply in &replies {
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    }
    // The same sale id sent concurrently: one create, the rest replays, one entry.
    let same = credit_body(&w, customer, "cash", Some(10_000), Some(20_000), &now_iso()).await;
    let replies = futures_util::future::join_all(
        (0..5).map(|_| w.call("POST", SALES, &w.seller, same.clone())),
    )
    .await;
    let statuses: Vec<_> = replies.iter().map(|r| r.status).collect();
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count(),
        1,
        "{statuses:?}"
    );
    assert!(
        statuses
            .iter()
            .all(|s| matches!(*s, StatusCode::CREATED | StatusCode::OK)),
        "{statuses:?}"
    );
    // Repayments racing credit sales keep the running balances consistent.
    let mut more = Vec::new();
    for _ in 0..4 {
        more.push(credit_body(&w, customer, "credit", Some(PRICE), None, &now_iso()).await);
    }
    let keys: Vec<_> = (0..4).map(|i| format!("race-{i}")).collect();
    let sales = more
        .iter()
        .map(|body| w.call("POST", SALES, &w.seller, body.clone()));
    let repayments = keys.iter().map(|key| {
        keyed(
            &w,
            customer,
            "repayments",
            Some(key),
            json!({"amount":1_000,"method":"cash"}),
            &w.seller,
            StatusCode::CREATED,
        )
    });
    let (sale_replies, _) = futures_util::future::join(
        futures_util::future::join_all(sales),
        futures_util::future::join_all(repayments),
    )
    .await;
    for reply in &sale_replies {
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    }
    let entries = entries_of(&w, customer).await;
    assert_eq!(entries.len(), 10 + 1 + 4 + 4);
    let expected = 10 * PRICE + 10_000 + 4 * PRICE - 4_000;
    assert_eq!(get(&w, customer).await["balance"], expected);
    let mut balances: Vec<i64> = entries
        .iter()
        .map(|e| e["balance_after"].as_i64().unwrap())
        .collect();
    balances.sort_unstable();
    balances.dedup();
    assert_eq!(balances.len(), entries.len(), "running balances are unique");
    assert_eq!(w.events("debt.recorded").await, 15);
}
