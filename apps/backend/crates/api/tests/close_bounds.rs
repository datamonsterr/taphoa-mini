//! Day close and debt-entry bounds (#198, #200, #201, #202) and the error envelope of oversized
//! and malformed requests (#159). Runs against the real router with the production sale window.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::{Duration, NaiveDate, Utc};
use common::world::{World, send};
use serde_json::{Value, json};
use taphoa_api::time::{SaleWindow, business_date};
use tower::ServiceExt;
use uuid::Uuid;

/// A world whose router uses the production 72 hour window (the shared fixtures widen it).
fn with_production_window(w: &World) -> axum::Router {
    let mut state = w.state.clone();
    state.sale_window = SaleWindow::default();
    taphoa_api::router(state)
}
async fn customer(app: &axum::Router, w: &World) -> Uuid {
    let id = Uuid::now_v7();
    let reply = send(
        app,
        "POST",
        "/v1/customers",
        Some(&w.seller),
        json!({"id":id,"name":"Khách"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    id
}
async fn entry(
    app: &axum::Router,
    token: &str,
    customer: Uuid,
    kind: &str,
    body: Value,
) -> (StatusCode, Value) {
    let reply = app
        .clone()
        .oneshot(
            Request::post(format!("/v1/customers/{customer}/{kind}"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .header("idempotency-key", Uuid::now_v7().to_string())
                .header("x-forwarded-for", "10.9.9.9")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = reply.status();
    let raw = to_bytes(reply.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
}
fn day(offset_hours: i64) -> NaiveDate {
    business_date(Utc::now() + Duration::hours(offset_hours))
}

/// #198: a close needs a business day that has happened, inside a sane window.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn day_close_rejects_future_and_ancient_dates() {
    let w = World::new().await;
    let put = |date: String| {
        let w = &w;
        async move {
            w.call(
                "PUT",
                &format!("/v1/day-closes/{date}"),
                &w.lead,
                json!({"counted_cash":5000}),
            )
            .await
        }
    };
    for date in [
        "2099-01-01".to_string(),
        "1900-01-01".to_string(),
        day(24).to_string(),
    ] {
        let reply = put(date.clone()).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{date}: {}",
            reply.body
        );
        assert_eq!(reply.body["code"], "validation_failed", "{date}");
        let stored = w
            .call(
                "GET",
                &format!("/v1/day-closes/{date}"),
                &w.lead,
                Value::Null,
            )
            .await;
        assert_eq!(
            stored.status,
            StatusCode::NOT_FOUND,
            "{date} must not be stored"
        );
    }
    for date in [day(0), day(-24)] {
        let reply = put(date.to_string()).await;
        assert_eq!(reply.status, StatusCode::OK, "{date}: {}", reply.body);
    }
}

/// #200: paid_at and adjusted_at cannot move cash to a future day or onto a closed day.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn repayment_and_adjustment_times_are_bounded() {
    let w = World::new().await;
    let app = with_production_window(&w);
    let c = customer(&app, &w).await;
    let today = business_date(Utc::now()).to_string();
    let ago = |d: Duration| (Utc::now() - d).to_rfc3339();
    // Outside the window the entry still records, at server time.
    for at in [
        "2099-06-01T03:00:00Z".to_string(),
        ago(Duration::days(365)),
        (Utc::now() + Duration::minutes(30)).to_rfc3339(),
    ] {
        let body = json!({"amount":7000,"method":"cash","paid_at":at});
        let (status, body) = entry(&app, &w.seller, c, "repayments", body).await;
        assert_eq!(status, StatusCode::CREATED, "{at}: {}", body);
        assert_eq!(body["business_date"], today, "{at}");
    }
    let report = w
        .call(
            "GET",
            "/v1/reports/today?date=2099-06-01",
            &w.lead,
            Value::Null,
        )
        .await;
    assert_eq!(report.body["cash_repayments"], 0, "{}", report.body);
    // Yesterday is closed: a seller's repayment from yesterday lands today, the Lead's keeps its date.
    let yesterday = Utc::now() - Duration::hours(24);
    let closed = business_date(yesterday).to_string();
    let close = w
        .call(
            "PUT",
            &format!("/v1/day-closes/{closed}"),
            &w.lead,
            json!({"counted_cash":0}),
        )
        .await;
    assert_eq!(close.status, StatusCode::OK, "{}", close.body);
    let body = json!({"amount":1000,"method":"cash","paid_at":yesterday.to_rfc3339()});
    let (_, seller) = entry(&app, &w.seller, c, "repayments", body.clone()).await;
    assert_eq!(seller["business_date"], today);
    let (_, lead) = entry(&app, &w.lead, c, "repayments", body).await;
    assert_eq!(lead["business_date"], closed);
    let body = json!({"amount":500,"reason":"x","adjusted_at":"2099-01-01T00:00:00Z"});
    let (_, adjusted) = entry(&app, &w.lead, c, "adjustments", body).await;
    assert_eq!(adjusted["business_date"], today);
    // Inside the window and on an open day the client time is kept.
    let recent = Utc::now() - Duration::minutes(10);
    let body = json!({"amount":10,"method":"cash","paid_at":recent.to_rfc3339()});
    let (_, kept) = entry(&app, &w.seller, c, "repayments", body).await;
    assert_eq!(kept["business_date"], business_date(recent).to_string());
}

/// #201: repayments and adjustments stop at the same 10^12 cap as expenses.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn repayment_and_adjustment_amounts_have_an_upper_bound() {
    let w = World::new().await;
    let app = with_production_window(&w);
    let c = customer(&app, &w).await;
    let cap = 1_000_000_000_000_i64;
    for amount in [i64::MAX, cap + 1] {
        let body = json!({"amount":amount,"method":"cash"});
        let (status, body) = entry(&app, &w.seller, c, "repayments", body).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{amount}: {}",
            body
        );
        assert_eq!(body["code"], "validation_failed");
    }
    for amount in [i64::MAX, i64::MIN, cap + 1, -cap - 1] {
        let body = json!({"amount":amount,"reason":"x"});
        let (status, body) = entry(&app, &w.lead, c, "adjustments", body).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{amount}: {}",
            body
        );
    }
    let body = json!({"amount":cap,"method":"cash"});
    let (status, body) = entry(&app, &w.seller, c, "repayments", body).await;
    assert_eq!(status, StatusCode::CREATED, "{}", body);
    let body = json!({"amount":-cap,"reason":"x"});
    let (status, _) = entry(&app, &w.lead, c, "adjustments", body).await;
    assert_eq!(status, StatusCode::CREATED);
}

/// #202: what arrives after a close shows up in `late_sales_count`, repayments included.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn repayments_after_a_close_count_as_late() {
    let w = World::new().await;
    let app = with_production_window(&w);
    let c = customer(&app, &w).await;
    let today = business_date(Utc::now());
    let path = format!("/v1/day-closes/{today}");
    let close = w
        .call("PUT", &path, &w.lead, json!({"counted_cash":0}))
        .await;
    assert_eq!(close.body["late_sales_count"], 0);
    let body = json!({"amount":4000,"method":"cash"});
    let (status, _) = entry(&app, &w.seller, c, "repayments", body).await;
    assert_eq!(status, StatusCode::CREATED);
    let after = w.call("GET", &path, &w.lead, Value::Null).await;
    assert_eq!(after.body["late_sales_count"], 1, "{}", after.body);
    // Closing again recomputes the expected cash and resets the late count.
    let again = w
        .call("PUT", &path, &w.lead, json!({"counted_cash":4000}))
        .await;
    assert_eq!(again.body["expected_cash"], 4000, "{}", again.body);
    let after = w.call("GET", &path, &w.lead, Value::Null).await;
    assert_eq!(after.body["late_sales_count"], 0);
}

type Raw = (StatusCode, Option<String>, Vec<u8>);
async fn raw(app: &axum::Router, req: Request<Body>) -> Raw {
    let reply = app.clone().oneshot(req).await.unwrap();
    let status = reply.status();
    let kind = reply
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = to_bytes(reply.into_body(), 1 << 20).await.unwrap().to_vec();
    (status, kind, body)
}
fn post(w: &World, uri: &str, kind: &str, body: Vec<u8>) -> Request<Body> {
    Request::post(uri)
        .header("content-type", kind)
        .header("content-length", body.len())
        .header("authorization", format!("Bearer {}", w.lead))
        .header("x-forwarded-for", "10.8.8.8")
        .body(Body::from(body))
        .unwrap()
}
/// Assert the JSON envelope and return its message.
fn envelope(reply: Raw, want: StatusCode, code: &str) -> String {
    let (status, kind, body) = reply;
    assert_eq!(status, want, "{}", String::from_utf8_lossy(&body));
    assert!(kind.is_some_and(|k| k.starts_with("application/json")));
    let json: Value = serde_json::from_slice(&body).expect("JSON envelope");
    assert_eq!(json["code"], code);
    json["error"].as_str().unwrap().to_string()
}

/// #159: oversized and malformed requests answer with the code/error envelope and fixed text.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn oversized_and_malformed_requests_use_the_error_envelope() {
    let w = World::new().await;
    let json_kind = "application/json";
    // JSON body over the 2 MB default.
    let big = json!({"id":Uuid::now_v7(),"name":"a".repeat(3 << 20)}).to_string();
    let reply = raw(
        &w.app,
        post(&w, "/v1/customers", json_kind, big.into_bytes()),
    )
    .await;
    envelope(reply, StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    // Multipart routes: the body-limit layer answers before any handler.
    for uri in ["/v1/images", "/v1/segment"] {
        let kind = "multipart/form-data; boundary=x";
        let reply = raw(&w.app, post(&w, uri, kind, vec![b'a'; 11 << 20])).await;
        envelope(reply, StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    }
    // Parser text never reaches the client.
    let nested = "[".repeat(5000);
    for body in ["{\"name\":", "{\"name\":1,", nested.as_str()] {
        let reply = raw(
            &w.app,
            post(&w, "/v1/customers", json_kind, body.as_bytes().to_vec()),
        )
        .await;
        let message = envelope(reply, StatusCode::BAD_REQUEST, "validation_failed");
        assert!(message.starts_with("invalid JSON body"), "{message}");
        assert!(message.len() < 40, "{message}");
    }
    let wrong_type = br#"{"id":"x","name":1}"#.to_vec();
    let reply = raw(&w.app, post(&w, "/v1/customers", json_kind, wrong_type)).await;
    let message = envelope(reply, StatusCode::BAD_REQUEST, "validation_failed");
    assert!(!message.contains("expected"), "{message}");
    for uri in ["/v1/reports/summary?from=zzz", "/v1/reports/summary"] {
        let req = Request::get(uri)
            .header("authorization", format!("Bearer {}", w.lead))
            .header("x-forwarded-for", "10.8.8.8")
            .body(Body::empty())
            .unwrap();
        let message = envelope(
            raw(&w.app, req).await,
            StatusCode::BAD_REQUEST,
            "validation_failed",
        );
        assert_eq!(message, "invalid query string");
    }
    // A number beyond i64 inside a sale body.
    let sale = br#"{"id":"01980000-0000-7000-8000-000000000000","total":1e23}"#.to_vec();
    let reply = raw(&w.app, post(&w, "/v1/sales", json_kind, sale)).await;
    let message = envelope(reply, StatusCode::BAD_REQUEST, "validation_failed");
    assert!(!message.contains("floating point"), "{message}");
}
