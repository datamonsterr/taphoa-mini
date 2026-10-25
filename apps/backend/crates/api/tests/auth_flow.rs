//! Clerk identity, persisted memberships and PIN contracts over real PostgreSQL/Redis.
mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::{
    Contract,
    clerk::{self, clerk_token},
    world::{World, send},
};
use serde_json::{Value, json};
use taphoa_api::{AppState, config::Config, router};
use tower::ServiceExt;
use uuid::Uuid;
async fn setup() -> (Router, AppState) {
    let config = Config::from_lookup(|k| match k {
        "CLERK_ISSUER" => Some(clerk::TEST_ISSUER.into()),
        "CLERK_SECRET_KEY" => None,
        "CLIENT_IP_SOURCE" => Some("x-forwarded-for".into()),
        _ => std::env::var(k).ok(),
    })
    .unwrap();
    let mut state = AppState::connect_with_config(&config, None).await.unwrap();
    clerk::install(&mut state);
    (router(state.clone()), state)
}
async fn selected(app: &Router, token: &str, store: Option<&str>) -> (StatusCode, Value) {
    let mut req = Request::get("/v1/store").header("authorization", format!("Bearer {token}"));
    if let Some(store) = store {
        req = req.header("X-Store-Id", store);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn create(app: &Router, token: &str) -> Value {
    let r = send(
        app,
        "POST",
        "/v1/stores",
        Some(token),
        json!({"store_name":"Tạp hóa","display_name":"Lead"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    Contract::load().assert_conforms("/v1/stores", "post", r.status, &r.body);
    r.body
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn actor_resolves_zero_one_two_memberships_and_store_headers() {
    let (app, state) = setup().await;
    let user = clerk::user();
    let token = clerk_token(&user, "sess_selection");
    let zero = selected(&app, &token, None).await;
    assert_eq!(zero.0, StatusCode::FORBIDDEN);
    assert_eq!(zero.1["code"], "membership_required");
    let first = create(&app, &token).await;
    let a = first["store"]["id"].as_str().unwrap();
    assert_eq!(selected(&app, &token, None).await.1["id"], a);
    assert_eq!(selected(&app, &token, Some(a)).await.0, StatusCode::OK);
    for invalid in ["garbage", ""] {
        let r = selected(&app, &token, Some(invalid)).await;
        assert_eq!(r.0, StatusCode::BAD_REQUEST);
        assert_eq!(r.1["code"], "validation_failed");
    }
    let foreign = Uuid::new_v4().to_string();
    let r = selected(&app, &token, Some(&foreign)).await;
    assert_eq!(r.0, StatusCode::FORBIDDEN);
    assert_eq!(r.1["code"], "forbidden");
    let second = create(&app, &token).await;
    let b = second["store"]["id"].as_str().unwrap();
    let r = selected(&app, &token, None).await;
    assert_eq!(r.0, StatusCode::BAD_REQUEST);
    assert_eq!(r.1["code"], "store_required");
    assert_eq!(selected(&app, &token, Some(b)).await.1["id"], b);
    let me = send(&app, "GET", "/v1/me", Some(&token), Value::Null).await;
    Contract::load().assert_conforms("/v1/me", "get", me.status, &me.body);
    assert_eq!(me.body["clerk_user_id"], user);
    assert!(me.body["profile"].is_null());
    assert_eq!(me.body["memberships"][0], first);
    assert_eq!(me.body["memberships"][1], second);
    sqlx::query("UPDATE members SET active=false WHERE store_id=$1")
        .bind(b.parse::<Uuid>().unwrap())
        .execute(state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(selected(&app, &token, None).await.1["id"], a);
    assert_eq!(selected(&app, &token, Some(b)).await.1["code"], "forbidden");
    let me = send(&app, "GET", "/v1/me", Some(&token), Value::Null).await;
    assert_eq!(me.body["memberships"].as_array().unwrap().len(), 1);
    sqlx::query("UPDATE members SET active=false WHERE clerk_user_id=$1")
        .bind(&user)
        .execute(state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(
        selected(&app, &token, None).await.1["code"],
        "membership_required"
    );
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn join_conflict_consumption_and_reactivation() {
    let w = World::new().await;
    let token = clerk::token();
    let invite = w.call("POST", "/v1/invites", &w.lead, json!({})).await.body;
    let body = json!({"invite_token":invite["token"],"display_name":"New"});
    let joined = w.call("POST", "/v1/auth/join", &token, body.clone()).await;
    assert_eq!(joined.status, StatusCode::CREATED, "{}", joined.body);
    Contract::load().assert_conforms("/v1/auth/join", "post", joined.status, &joined.body);
    assert_eq!(
        w.call("POST", "/v1/auth/join", &token, body).await.body["code"],
        "invite_unavailable"
    );
    let invite = w
        .call(
            "POST",
            "/v1/invites",
            &w.lead,
            json!({"role":"lead","can_enroll":true}),
        )
        .await
        .body;
    let body = json!({"invite_token":invite["token"],"display_name":"Returned"});
    let conflict = w.call("POST", "/v1/auth/join", &token, body.clone()).await;
    assert_eq!(conflict.status, StatusCode::CONFLICT);
    assert_eq!(conflict.body["code"], "already_member");
    let id = joined.body["member"]["id"].as_str().unwrap();
    assert_eq!(
        w.call("DELETE", &format!("/v1/members/{id}"), &w.lead, Value::Null)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        w.call("GET", "/v1/store", &token, Value::Null).await.body["code"],
        "membership_required"
    );
    let back = w.call("POST", "/v1/auth/join", &token, body).await;
    assert_eq!(back.status, StatusCode::CREATED, "{}", back.body);
    assert_eq!(back.body["member"]["id"], id);
    assert_eq!(back.body["member"]["role"], "lead");
    assert_eq!(back.body["member"]["can_enroll"], true);
    assert_eq!(back.body["member"]["display_name"], "Returned");
    let expired = w.call("POST", "/v1/invites", &w.lead, json!({})).await.body;
    sqlx::query("UPDATE invites SET expires_at=now()-interval '1 second' WHERE token_hash=$1")
        .bind(taphoa_api::auth::crypto::token_hash(
            expired["token"].as_str().unwrap(),
        ))
        .execute(w.pool())
        .await
        .unwrap();
    assert_eq!(
        w.call(
            "POST",
            "/v1/auth/join",
            &clerk::token(),
            json!({"invite_token":expired["token"],"display_name":"Late"})
        )
        .await
        .status,
        StatusCode::GONE
    );
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn pin_verify_no_pin_match_failure_reset_and_lockout() {
    let w = World::new().await;
    assert_eq!(
        w.call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"1234"}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    for pin in [json!("abc"), json!(12)] {
        assert_eq!(
            w.call("PUT", "/v1/me/pin", &w.lead, json!({"pin":pin}))
                .await
                .status,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        w.call("PUT", "/v1/me/pin", &w.lead, json!({"pin":"1234"}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let wrong = w
        .call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"9999"}))
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.body["code"], "invalid_pin");
    assert_eq!(
        w.call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"1234"}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    for n in 0..w.state.rate_limits.pin_attempts {
        let r = w
            .call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"9999"}))
            .await;
        assert_eq!(
            r.status,
            if n + 1 == w.state.rate_limits.pin_attempts {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    let r = w
        .call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"1234"}))
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.headers.contains_key("retry-after"));
    assert_eq!(
        w.call("PUT", "/v1/me/pin", &w.lead, json!({"pin":null}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        w.call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"1234"}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
}
#[tokio::test]
async fn invalid_tokens_and_no_database_fail_closed() {
    let mut state = AppState::default();
    clerk::install(&mut state);
    let app = router(state);
    let now = jsonwebtoken::get_current_timestamp();
    for token in [
        "garbage".into(),
        clerk::sign(json!({"sub":"user","sid":"sess","iss":clerk::TEST_ISSUER,"exp":now-30})),
        clerk::sign(json!({"sub":"user","sid":"sess","iss":"https://foreign.test","exp":now+1000})),
    ] {
        assert_eq!(
            send(&app, "GET", "/v1/me", Some(&token), Value::Null)
                .await
                .status,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        send(&app, "GET", "/v1/store", Some(&clerk::token()), Value::Null)
            .await
            .status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    for path in [
        "/v1/auth/recover",
        "/v1/auth/refresh",
        "/v1/auth/switch",
        "/v1/auth/logout",
    ] {
        assert_eq!(
            send(&app, "POST", path, None, json!({})).await.status,
            StatusCode::NOT_FOUND
        );
    }
}
