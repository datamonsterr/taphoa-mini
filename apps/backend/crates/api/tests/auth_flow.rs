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
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn parallel_pin_verifications_stop_at_the_attempt_cap() {
    let w = World::new().await;
    assert_eq!(
        w.call("PUT", "/v1/me/pin", &w.lead, json!({"pin":"1234"}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let cap = w.state.rate_limits.pin_attempts as usize;
    // Every request is in flight before the first hash check finishes. Counting an
    // attempt only after verifying it would let all of them be verified.
    let replies = futures_util::future::join_all(
        (0..cap * 3).map(|_| w.call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"1234"}))),
    )
    .await;
    let verified = replies
        .iter()
        .filter(|r| r.status == StatusCode::NO_CONTENT)
        .count();
    let limited = replies
        .iter()
        .filter(|r| r.status == StatusCode::TOO_MANY_REQUESTS)
        .count();
    assert!(
        (1..=cap).contains(&verified),
        "{verified} verified, cap {cap}"
    );
    assert_eq!(verified + limited, cap * 3);
    // The overflow locked the member out, even for the right PIN.
    let locked = w
        .call("POST", "/v1/me/pin/verify", &w.lead, json!({"pin":"1234"}))
        .await;
    assert_eq!(locked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(locked.headers.contains_key("retry-after"));
}

#[tokio::test]
async fn invalid_tokens_and_no_database_fail_closed() {
    let mut state = AppState::default();
    clerk::install(&mut state);
    let app = router(state);
    let now = jsonwebtoken::get_current_timestamp();
    for token in [
        "garbage".into(),
        clerk::sign(
            json!({"sub":"user","sid":"sess","iss":clerk::TEST_ISSUER,"exp":now-30,"nbf":now-100}),
        ),
        clerk::sign(
            json!({"sub":"user","sid":"sess","iss":"https://foreign.test","exp":now+1000,"nbf":now-100}),
        ),
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

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn validation_invite_expiry_and_ip_limits() {
    let (_, mut state) = setup().await;
    state.rate_limiter = std::sync::Arc::new(taphoa_api::ratelimit::MemoryRateLimiter::default());
    state.client_ip = taphoa_api::ratelimit::ClientIpSource::Peer;
    state.rate_limits.store_create_per_hour = 2;
    state.rate_limits.join_per_hour = 2;
    let app = router(state);
    let token = clerk::token();
    for (path, body, status) in [
        (
            "/v1/stores",
            json!({"store_name":"","display_name":"Lead"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "/v1/auth/join",
            json!({"invite_token":"unknown","display_name":"Seller"}),
            StatusCode::GONE,
        ),
    ] {
        for n in 0..3 {
            // send() changes the forwarded IP each time, but peer mode keeps one counter.
            let r = send(&app, "POST", path, Some(&token), body.clone()).await;
            assert_eq!(
                r.status,
                if n < 2 {
                    status
                } else {
                    StatusCode::TOO_MANY_REQUESTS
                },
                "{}",
                r.body
            );
            if n == 2 {
                assert!(r.headers.contains_key("retry-after"));
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn member_and_store_lifecycle_and_single_use_invite_concurrency() {
    let w = World::new().await;
    let initial:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM change_log WHERE store_id=$1),(SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='member.changed')").bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    assert_eq!(initial, (3, 2));
    for (path, method, body, code) in [
        (
            "/v1/store".to_owned(),
            "PATCH",
            json!({"name":"foreign"}),
            StatusCode::FORBIDDEN,
        ),
        (
            "/v1/invites".to_owned(),
            "POST",
            json!({}),
            StatusCode::FORBIDDEN,
        ),
        (
            format!("/v1/members/{}", w.lead_id),
            "DELETE",
            Value::Null,
            StatusCode::FORBIDDEN,
        ),
    ] {
        assert_eq!(w.call(method, &path, &w.seller, body).await.status, code);
    }
    for method in ["PATCH", "DELETE"] {
        let r = w
            .call(
                method,
                &format!("/v1/members/{}", w.lead_id),
                &w.lead,
                json!({"role":"seller"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT);
        assert_eq!(r.body["code"], "last_lead");
    }
    let changed=w.call("PATCH","/v1/store",&w.lead,json!({"name":"New","margin_threshold_pct":12.5,"bank_account":{"bank_bin":"970436","account_number":"AB1234","account_name":"CO BA"}})).await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    assert_eq!(changed.body["version"], 2);
    let same = w.call("PATCH", "/v1/store", &w.lead, json!({})).await;
    assert_eq!(same.body["version"], 2);
    let malformed=send(&w.app,"POST","/v1/stores",Some(&clerk::token()),json!({"store_name":"s","display_name":"d","bank_account":{"bank_bin":"bad","account_number":"1234","account_name":"A"}})).await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    let invite = w.call("POST", "/v1/invites", &w.lead, json!({})).await.body;
    let body = json!({"invite_token":invite["token"],"display_name":"Concurrent"});
    let a = clerk::token();
    let b = clerk::token();
    let (a, b) = tokio::join!(
        w.call("POST", "/v1/auth/join", &a, body.clone()),
        w.call("POST", "/v1/auth/join", &b, body)
    );
    assert!([a.status, b.status].contains(&StatusCode::CREATED));
    assert!([a.status, b.status].contains(&StatusCode::GONE));
    let token = clerk::token();
    let me = send(&w.app, "GET", "/v1/me", Some(&token), Value::Null).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["memberships"], json!([]));
    for path in ["/v1/stores", "/v1/auth/join"] {
        assert_eq!(
            send(&w.app, "POST", path, None, json!({})).await.status,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sales_and_event_actor_persist_the_clerk_session_id() {
    let w = World::new().await;
    let product = w.product("Clerk sale", 10000, None).await;
    let id = Uuid::now_v7();
    let input = common::world::sale_body(
        id,
        &common::world::now_iso(),
        "cash",
        &[(product, 1, 10000)],
    );
    let r = w.call("POST", "/v1/sales", &w.seller, input).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let sid = w.state.clerk.verify(&w.seller).await.unwrap().session_id;
    let persisted: Option<String> =
        sqlx::query_scalar("SELECT clerk_session_id FROM sales WHERE id=$1")
            .bind(id)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some(sid.as_str()));
    let actor: Value = sqlx::query_scalar(
        "SELECT payload->'actor' FROM outbox_events WHERE store_id=$1 AND type='sale.created'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(actor, json!({"member_id":w.seller_id,"session_id":sid}));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL; prints local latency evidence"]
async fn local_postgres_endpoint_latencies() {
    let w = World::new().await;
    for path in ["/v1/me", "/v1/store"] {
        let mut micros = Vec::new();
        for _ in 0..200 {
            let start = std::time::Instant::now();
            let r = w.call("GET", path, &w.lead, Value::Null).await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.body);
            micros.push(start.elapsed().as_micros());
        }
        micros.sort_unstable();
        println!("{path} n=200 p50={}us p95={}us", micros[99], micros[189]);
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn membership_permissions_update_without_reissuing_the_token() {
    let w = World::new().await;
    let path = format!("/v1/members/{}", w.seller_id);
    assert_eq!(
        w.call(
            "PATCH",
            &path,
            &w.lead,
            json!({"role":"lead","can_enroll":false})
        )
        .await
        .body["can_enroll"],
        true
    );
    assert_eq!(
        w.call("POST", "/v1/invites", &w.seller, json!({}))
            .await
            .status,
        StatusCode::CREATED
    );
    assert_eq!(
        w.call(
            "PATCH",
            &path,
            &w.lead,
            json!({"role":"seller","can_enroll":false})
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        w.call("POST", "/v1/invites", &w.seller, json!({}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
}

struct ImageObjects;
#[async_trait::async_trait]
impl taphoa_api::storage::ObjectStore for ImageObjects {
    async fn put(&self, _: &str, _: &str, _: Vec<u8>) -> anyhow::Result<()> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn get(&self, _: &str) -> anyhow::Result<Vec<u8>> {
        Ok(Vec::new())
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
            url: format!("https://images.test/{key}"),
            expires_at: (std::time::SystemTime::now() + ttl).into(),
        })
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL; object storage is an in-memory stub"]
async fn persisted_images_are_owned_by_token_store_and_uploader() {
    let (_, mut state) = setup().await;
    state.storage = Some(std::sync::Arc::new(ImageObjects));
    let app = router(state.clone());
    let token_a = clerk::token();
    let token_b = clerk::token();
    let a = create(&app, &token_a).await;
    let b = create(&app, &token_b).await;
    let mut body=format!("--b\r\nContent-Disposition: form-data; name=\"store_id\"\r\n\r\n{}\r\n--b\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n",b["store"]["id"].as_str().unwrap()).into_bytes();
    body.extend_from_slice(include_bytes!("../../../tests/fixtures/sample.png"));
    body.extend_from_slice(b"\r\n--b--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/images")
                .header("authorization", format!("Bearer {}", token_a.as_str()))
                .header("content-type", "multipart/form-data; boundary=b")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let uploaded: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{uploaded}");
    Contract::load().assert_conforms("/v1/images", "post", status, &uploaded);
    let image_id: Uuid = uploaded["id"].as_str().unwrap().parse().unwrap();
    let owner: (Uuid, Uuid) = sqlx::query_as("SELECT store_id,uploaded_by FROM images WHERE id=$1")
        .bind(image_id)
        .fetch_one(state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(owner.0.to_string(), a["store"]["id"].as_str().unwrap());
    assert_eq!(owner.1.to_string(), a["member"]["id"].as_str().unwrap());
    for (token, expected) in [
        (token_a.as_str(), StatusCode::OK),
        (token_b.as_str(), StatusCode::NOT_FOUND),
    ] {
        let r = send(
            &app,
            "GET",
            &format!("/v1/images/{image_id}"),
            Some(token),
            Value::Null,
        )
        .await;
        assert_eq!(r.status, expected);
        Contract::load().assert_conforms("/v1/images/{imageId}", "get", r.status, &r.body);
    }
}
