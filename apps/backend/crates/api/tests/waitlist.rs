use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use taphoa_api::{AppState, router};
use tower::ServiceExt;

async fn post(app: &Router, body: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/waitlist")
                .header("content-type", "application/json")
                .body(Body::from(body.to_owned()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn invalid_and_malformed_bodies_return_the_contract_error() {
    let app = router(AppState::default());
    for body in [r#"{"email":"invalid"}"#, "{", r#"{}"#, r#"{"email":12}"#] {
        let (status, response) = post(&app, body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response["code"], "invalid_email");
        assert!(response["error"].is_string());
    }
}

#[tokio::test]
async fn requests_are_limited_per_client() {
    let app = router(AppState::default());
    for _ in 0..10 {
        assert_eq!(
            post(&app, r#"{"email":"bad"}"#).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let (status, response) = post(&app, r#"{"email":"bad"}"#).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response["code"], "too_many_requests");
}

#[tokio::test]
async fn valid_email_requires_postgres() {
    let (status, response) = post(&router(AppState::default()), r#"{"email":"a@b.c"}"#).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response["code"], "unavailable");
}

#[tokio::test]
async fn rate_limit_separates_client_ips() {
    use axum::extract::ConnectInfo;
    use std::net::SocketAddr;

    let app = router(AppState::default());
    for (ip, expected) in [
        ("192.0.2.1:1000", StatusCode::UNPROCESSABLE_ENTITY),
        ("192.0.2.1:2000", StatusCode::TOO_MANY_REQUESTS),
        ("192.0.2.2:1000", StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let attempts =
            if expected == StatusCode::UNPROCESSABLE_ENTITY && ip.starts_with("192.0.2.1") {
                10
            } else {
                1
            };
        for _ in 0..attempts {
            let mut request = Request::post("/v1/waitlist")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"email":"bad"}"#))
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(ip.parse::<SocketAddr>().unwrap()));
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::TOO_MANY_REQUESTS {
                assert!(response.headers().contains_key("retry-after"));
            }
        }
    }
}

#[tokio::test]
#[ignore = "real Postgres required; DATABASE_URL"]
async fn signup_is_normalized_and_idempotent() {
    let database_url =
        std::env::var("DATABASE_URL").expect("set DATABASE_URL for waitlist integration");
    let state = AppState::connect(Some(&database_url), None, None)
        .await
        .unwrap();
    let pool = state.postgres.clone().unwrap();
    let email = format!("waitlist-{}@example.com", uuid::Uuid::new_v4());
    let app = router(state);
    for input in [format!("  {}  ", email.to_uppercase()), email.clone()] {
        let (status, response) = post(&app, &json!({"email": input}).to_string()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response, json!({"status":"ok"}));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM waitlist_signups WHERE email = $1")
        .bind(&email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    sqlx::query("DELETE FROM waitlist_signups WHERE email = $1")
        .bind(email)
        .execute(&pool)
        .await
        .unwrap();
}
