//! Real PostgreSQL/Redis API and OpenAPI contract tests.
mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::Contract;
use serde_json::{Value, json};
use taphoa_api::{AppState, config::Config, router};
use tower::ServiceExt;
use uuid::Uuid;
async fn setup() -> (Router, AppState) {
    let config = Config::from_lookup(|key| match key {
        "JWT_SECRET" => Some("auth-flow-test-secret-at-least-32-bytes".into()),
        _ => std::env::var(key).ok(),
    })
    .unwrap();
    let state = AppState::connect_with_config(&config, None).await.unwrap();
    (router(state.clone()), state)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
fn device() -> Value {
    json!({"name":"counter","platform":"web","app_version":"1.0"})
}
fn access(s: &Value) -> &str {
    s["access_token"].as_str().unwrap()
}
async fn checked(
    app: &Router,
    method: &str,
    path: &str,
    template: &str,
    token: Option<&str>,
    input: Value,
    expected: StatusCode,
) -> Value {
    let (status, body) = call(app, method, path, token, input).await;
    assert_eq!(status, expected, "{method} {path}: {body}");
    if expected != StatusCode::NO_CONTENT {
        Contract::load().assert_conforms(template, &method.to_lowercase(), status, &body);
    }
    body
}
async fn create(app: &Router) -> Value {
    checked(app,"POST","/v1/stores","/v1/stores",None,json!({"store_name":"Tạp hóa","display_name":"Lead","device":device(),"bank_account":{"bank_bin":"970436","account_number":"AB1234","account_name":"CO BA"}}),StatusCode::CREATED).await
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn full_auth_store_member_invite_lifecycle() {
    let (app, state) = setup().await;
    let lead = create(&app).await;
    let token = access(&lead);
    let sid = lead["store"]["id"].as_str().unwrap();
    let mid = lead["member"]["id"].as_str().unwrap();
    checked(
        &app,
        "GET",
        "/v1/me",
        "/v1/me",
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    checked(
        &app,
        "GET",
        "/v1/store",
        "/v1/store",
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    let changed=checked(&app,"PATCH","/v1/store","/v1/store",Some(token),json!({"name":"New","bank_account":null,"margin_threshold_pct":12.5,"sales_memo_prefix":"BA"}),StatusCode::OK).await;
    assert!(changed["bank_account"].is_null());
    assert_eq!(changed["version"], 2);
    let unchanged = checked(
        &app,
        "PATCH",
        "/v1/store",
        "/v1/store",
        Some(token),
        json!({}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(unchanged["name"], "New");
    checked(
        &app,
        "PATCH",
        "/v1/store",
        "/v1/store",
        Some(token),
        json!({"margin_threshold_pct":101}),
        StatusCode::BAD_REQUEST,
    )
    .await;
    checked(
        &app,
        "PUT",
        "/v1/me/pin",
        "/v1/me/pin",
        Some(token),
        json!({"pin":"abc"}),
        StatusCode::BAD_REQUEST,
    )
    .await;
    checked(
        &app,
        "PUT",
        "/v1/me/pin",
        "/v1/me/pin",
        Some(token),
        json!({"pin":"1234"}),
        StatusCode::NO_CONTENT,
    )
    .await;
    let invite = checked(
        &app,
        "POST",
        "/v1/invites",
        "/v1/invites",
        Some(token),
        json!({}),
        StatusCode::CREATED,
    )
    .await;
    let join = json!({"invite_token":invite["token"],"display_name":"Seller","device":device()});
    let seller = checked(
        &app,
        "POST",
        "/v1/auth/join",
        "/v1/auth/join",
        None,
        join.clone(),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        checked(
            &app,
            "POST",
            "/v1/auth/join",
            "/v1/auth/join",
            None,
            join,
            StatusCode::GONE
        )
        .await["code"],
        "invite_unavailable"
    );
    checked(
        &app,
        "PATCH",
        "/v1/store",
        "/v1/store",
        Some(access(&seller)),
        json!({"name":"forbidden"}),
        StatusCode::FORBIDDEN,
    )
    .await;
    checked(
        &app,
        "POST",
        "/v1/invites",
        "/v1/invites",
        Some(access(&seller)),
        json!({}),
        StatusCode::FORBIDDEN,
    )
    .await;
    let members = checked(
        &app,
        "GET",
        "/v1/members",
        "/v1/members",
        Some(access(&seller)),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(members["items"].as_array().unwrap().len(), 2);
    for method in ["PATCH", "DELETE"] {
        assert_eq!(
            checked(
                &app,
                method,
                &format!("/v1/members/{mid}"),
                "/v1/members/{memberId}",
                Some(token),
                json!({"role":"seller"}),
                StatusCode::CONFLICT
            )
            .await["code"],
            "last_lead"
        );
    }
    checked(
        &app,
        "POST",
        "/v1/auth/switch",
        "/v1/auth/switch",
        Some(access(&seller)),
        json!({"member_id":mid}),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    for _ in 0..3 {
        checked(
            &app,
            "POST",
            "/v1/auth/switch",
            "/v1/auth/switch",
            Some(access(&seller)),
            json!({"member_id":mid,"pin":"9999"}),
            StatusCode::UNAUTHORIZED,
        )
        .await;
    }
    let switched = checked(
        &app,
        "POST",
        "/v1/auth/switch",
        "/v1/auth/switch",
        Some(access(&seller)),
        json!({"member_id":mid,"pin":"1234"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(switched["member"]["id"], mid);
    for n in 0..5 {
        let (status, _) = call(
            &app,
            "POST",
            "/v1/auth/switch",
            Some(access(&seller)),
            json!({"member_id":mid,"pin":"9999"}),
        )
        .await;
        assert_eq!(
            status,
            if n == 4 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    checked(
        &app,
        "POST",
        "/v1/auth/switch",
        "/v1/auth/switch",
        Some(access(&seller)),
        json!({"member_id":mid,"pin":"1234"}),
        StatusCode::TOO_MANY_REQUESTS,
    )
    .await;
    let path = format!("/v1/members/{}", seller["member"]["id"].as_str().unwrap());
    checked(
        &app,
        "PATCH",
        &path,
        "/v1/members/{memberId}",
        Some(token),
        json!({"display_name":"Updated","can_enroll":true}),
        StatusCode::OK,
    )
    .await;
    checked(
        &app,
        "DELETE",
        &path,
        "/v1/members/{memberId}",
        Some(token),
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    checked(
        &app,
        "GET",
        "/v1/me",
        "/v1/me",
        Some(access(&seller)),
        Value::Null,
        StatusCode::UNAUTHORIZED,
    )
    .await;
    let refresh = checked(
        &app,
        "POST",
        "/v1/auth/refresh",
        "/v1/auth/refresh",
        None,
        json!({"refresh_token":lead["refresh_token"]}),
        StatusCode::OK,
    )
    .await;
    for old in [&lead, &refresh] {
        checked(
            &app,
            "POST",
            "/v1/auth/refresh",
            "/v1/auth/refresh",
            None,
            json!({"refresh_token":old["refresh_token"]}),
            StatusCode::UNAUTHORIZED,
        )
        .await;
    }
    let normalized = lead["recovery_code"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .replace('-', " ");
    let recovered = checked(
        &app,
        "POST",
        "/v1/auth/recover",
        "/v1/auth/recover",
        None,
        json!({"recovery_code":normalized,"device":device(),"revoke_other_sessions":true}),
        StatusCode::OK,
    )
    .await;
    assert_ne!(recovered["recovery_code"], lead["recovery_code"]);
    checked(
        &app,
        "POST",
        "/v1/auth/recover",
        "/v1/auth/recover",
        None,
        json!({"recovery_code":lead["recovery_code"],"device":device()}),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    checked(
        &app,
        "PUT",
        "/v1/me/pin",
        "/v1/me/pin",
        Some(access(&recovered)),
        json!({"pin":null}),
        StatusCode::NO_CONTENT,
    )
    .await;
    checked(
        &app,
        "POST",
        "/v1/auth/logout",
        "/v1/auth/logout",
        Some(access(&recovered)),
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    checked(
        &app,
        "GET",
        "/v1/me",
        "/v1/me",
        Some(access(&recovered)),
        Value::Null,
        StatusCode::UNAUTHORIZED,
    )
    .await;
    let pool = state.postgres.as_ref().unwrap();
    let store_id: Uuid = sid.parse().unwrap();
    let entities: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT entity FROM change_log WHERE store_id=$1")
            .bind(store_id)
            .fetch_all(pool)
            .await
            .unwrap();
    for entity in ["store", "member"] {
        assert!(entities.contains(&entity.into()));
    }
    let reasons:Vec<String>=sqlx::query_scalar("SELECT payload->'data'->>'reason' FROM outbox_events WHERE store_id=$1 AND type='session.revoked'").bind(store_id).fetch_all(pool).await.unwrap();
    for reason in ["logout", "recovery", "token_reuse", "member_removed"] {
        assert!(reasons.contains(&reason.into()), "{reasons:?}");
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn cross_store_isolation_and_refresh_concurrency() {
    let (app, state) = setup().await;
    let a = create(&app).await;
    let b = create(&app).await;
    let target = a["member"]["id"].as_str().unwrap();
    for method in ["PATCH", "DELETE"] {
        checked(
            &app,
            method,
            &format!("/v1/members/{target}"),
            "/v1/members/{memberId}",
            Some(access(&b)),
            json!({"display_name":"intruder"}),
            StatusCode::NOT_FOUND,
        )
        .await;
    }
    checked(
        &app,
        "POST",
        "/v1/auth/switch",
        "/v1/auth/switch",
        Some(access(&b)),
        json!({"member_id":target}),
        StatusCode::NOT_FOUND,
    )
    .await;
    let members = checked(
        &app,
        "GET",
        "/v1/members",
        "/v1/members",
        Some(access(&b)),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert!(
        members["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["id"] != target)
    );
    let input = json!({"refresh_token":a["refresh_token"]});
    let (x, y) = tokio::join!(
        call(&app, "POST", "/v1/auth/refresh", None, input.clone()),
        call(&app, "POST", "/v1/auth/refresh", None, input)
    );
    assert!(
        (x.0 == StatusCode::OK && y.0 == StatusCode::UNAUTHORIZED)
            || (y.0 == StatusCode::OK && x.0 == StatusCode::UNAUTHORIZED)
    );
    let winner = if x.0 == StatusCode::OK { x.1 } else { y.1 };
    checked(
        &app,
        "POST",
        "/v1/auth/refresh",
        "/v1/auth/refresh",
        None,
        json!({"refresh_token":winner["refresh_token"]}),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    sqlx::query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE store_id=$1")
        .bind(b["store"]["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    checked(
        &app,
        "POST",
        "/v1/auth/refresh",
        "/v1/auth/refresh",
        None,
        json!({"refresh_token":b["refresh_token"]}),
        StatusCode::UNAUTHORIZED,
    )
    .await;
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL; prints local latency evidence"]
async fn local_postgres_endpoint_latencies() {
    let (app, _) = setup().await;
    let mut session = create(&app).await;
    for path in ["/v1/auth/refresh", "/v1/me"] {
        let mut micros = Vec::new();
        for _ in 0..200 {
            let start = std::time::Instant::now();
            let (status, body) = if path.ends_with("refresh") {
                call(
                    &app,
                    "POST",
                    path,
                    None,
                    json!({"refresh_token":session["refresh_token"]}),
                )
                .await
            } else {
                call(&app, "GET", path, Some(access(&session)), Value::Null).await
            };
            assert_eq!(status, StatusCode::OK, "{body}");
            micros.push(start.elapsed().as_micros());
            if path.ends_with("refresh") {
                session = body;
            }
        }
        micros.sort_unstable();
        println!("{path} n=200 p50={}us p95={}us", micros[99], micros[189]);
    }
}
