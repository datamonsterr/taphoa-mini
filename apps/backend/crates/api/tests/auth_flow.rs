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
    let store_uuid: Uuid = sid.parse().unwrap();
    let initial:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM change_log WHERE store_id=$1),(SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='member.changed' AND payload->'data'->>'change'='joined'),(SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='store.changed')").bind(store_uuid).fetch_one(state.postgres.as_ref().unwrap()).await.unwrap();
    assert_eq!(initial, (2, 1, 0));

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
    let switched_actor = state.jwt.verify(access(&switched)).unwrap();
    let seller_actor = state.jwt.verify(access(&seller)).unwrap();
    assert_ne!(switched_actor.session_id, seller_actor.session_id);
    let copied: (String, String, Option<String>) =
        sqlx::query_as("SELECT device_name,platform,app_version FROM sessions WHERE id=$1")
            .bind(switched_actor.session_id)
            .fetch_one(state.postgres.as_ref().unwrap())
            .await
            .unwrap();
    assert_eq!(copied, ("counter".into(), "web".into(), Some("1.0".into())));

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

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn validation_invite_expiry_and_ip_limits() {
    let (app, state) = setup().await;
    for invalid in [
        json!({"store_name":"","display_name":"A","device":device()}),
        json!({"store_name":"A","display_name":"","device":device()}),
        json!({"store_name":"A","display_name":"A","device":{"name":"x","platform":"linux"}}),
        json!({"store_name":"A","display_name":"A","device":device(),"bank_account":{"bank_bin":"123","account_number":"1","account_name":"x"}}),
    ] {
        checked(
            &app,
            "POST",
            "/v1/stores",
            "/v1/stores",
            None,
            invalid,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
    let lead = create(&app).await;
    let token = access(&lead);
    for invalid in [
        json!({"sales_memo_prefix":"123456789"}),
        json!({"name":null}),
        json!({"margin_threshold_pct":-1}),
        json!({"bank_account":{"account_number":"invalid_"}}),
    ] {
        checked(
            &app,
            "PATCH",
            "/v1/store",
            "/v1/store",
            Some(token),
            invalid,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
    let partial = checked(
        &app,
        "PATCH",
        "/v1/store",
        "/v1/store",
        Some(token),
        json!({"bank_account":{"account_name":"NEW NAME"}}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(partial["bank_account"]["bank_bin"], "970436");
    let invite = checked(
        &app,
        "POST",
        "/v1/invites",
        "/v1/invites",
        Some(token),
        json!({"role":"lead","can_enroll":false,"ttl_seconds":60}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(invite["can_enroll"], false);
    let hash = taphoa_api::auth::crypto::token_hash(invite["token"].as_str().unwrap());
    sqlx::query("UPDATE invites SET expires_at=now()-interval '1 second' WHERE token_hash=$1")
        .bind(hash)
        .execute(state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    for token in [invite["token"].as_str().unwrap(), "unknown"] {
        checked(
            &app,
            "POST",
            "/v1/auth/join",
            "/v1/auth/join",
            None,
            json!({"invite_token":token,"display_name":"A","device":device()}),
            StatusCode::GONE,
        )
        .await;
    }
    checked(
        &app,
        "POST",
        "/v1/auth/refresh",
        "/v1/auth/refresh",
        None,
        json!({"refresh_token":"unknown"}),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    let ip = format!("rate-{}", Uuid::new_v4());
    for n in 0..6 {
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/auth/recover")
                    .header("content-type", "application/json")
                    .header("x-forwarded-for", format!("{ip}, proxy"))
                    .body(Body::from(
                        json!({"recovery_code":"wrong","device":device()}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if n < 5 {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::TOO_MANY_REQUESTS
            }
        );
        if n == 5 {
            assert!(response.headers().contains_key("retry-after"));
        }
    }
    for (path, limit, input) in [
        (
            "/v1/stores",
            10,
            json!({"store_name":"","display_name":"A","device":device()}),
        ),
        (
            "/v1/auth/join",
            10,
            json!({"invite_token":"invalid","display_name":"A","device":device()}),
        ),
    ] {
        let ip = format!("rate-{}", Uuid::new_v4());
        for n in 0..=limit {
            let response = app
                .clone()
                .oneshot(
                    Request::post(path)
                        .header("content-type", "application/json")
                        .header("x-forwarded-for", &ip)
                        .body(Body::from(input.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            if n == limit {
                assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            }
        }
    }
}

#[tokio::test]
async fn protected_routes_require_bearer_and_errors_match_contract() {
    let app = router(AppState::default());
    for (method, path, template) in [
        ("GET", "/v1/me", "/v1/me"),
        ("PUT", "/v1/me/pin", "/v1/me/pin"),
        ("GET", "/v1/store", "/v1/store"),
        ("PATCH", "/v1/store", "/v1/store"),
        ("GET", "/v1/members", "/v1/members"),
        (
            "PATCH",
            "/v1/members/00000000-0000-0000-0000-000000000000",
            "/v1/members/{memberId}",
        ),
        (
            "DELETE",
            "/v1/members/00000000-0000-0000-0000-000000000000",
            "/v1/members/{memberId}",
        ),
        ("POST", "/v1/auth/logout", "/v1/auth/logout"),
        ("POST", "/v1/auth/switch", "/v1/auth/switch"),
        ("POST", "/v1/invites", "/v1/invites"),
        ("POST", "/v1/images", "/v1/images"),
        (
            "GET",
            "/v1/images/00000000-0000-0000-0000-000000000000",
            "/v1/images/{imageId}",
        ),
    ] {
        checked(
            &app,
            method,
            path,
            template,
            None,
            json!({}),
            StatusCode::UNAUTHORIZED,
        )
        .await;
    }
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
    let a = create(&app).await;
    let b = create(&app).await;
    let mut body=format!("--b\r\nContent-Disposition: form-data; name=\"store_id\"\r\n\r\n{}\r\n--b\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n",b["store"]["id"].as_str().unwrap()).into_bytes();
    body.extend_from_slice(include_bytes!("../../../tests/fixtures/sample.png"));
    body.extend_from_slice(b"\r\n--b--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/images")
                .header("authorization", format!("Bearer {}", access(&a)))
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
        (access(&a), StatusCode::OK),
        (access(&b), StatusCode::NOT_FOUND),
    ] {
        checked(
            &app,
            "GET",
            &format!("/v1/images/{image_id}"),
            "/v1/images/{imageId}",
            Some(token),
            Value::Null,
            expected,
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn lead_changes_and_single_use_invites_are_serialized() {
    let (app, state) = setup().await;
    let original = create(&app).await;
    let invite = checked(
        &app,
        "POST",
        "/v1/invites",
        "/v1/invites",
        Some(access(&original)),
        json!({"role":"lead"}),
        StatusCode::CREATED,
    )
    .await;
    let input = json!({"invite_token":invite["token"],"display_name":"New Lead","device":device()});
    let (x, y) = tokio::join!(
        call(&app, "POST", "/v1/auth/join", None, input.clone()),
        call(&app, "POST", "/v1/auth/join", None, input)
    );
    assert!(
        (x.0 == StatusCode::CREATED && y.0 == StatusCode::GONE)
            || (y.0 == StatusCode::CREATED && x.0 == StatusCode::GONE)
    );
    let joined = if x.0 == StatusCode::CREATED { x.1 } else { y.1 };
    assert_eq!(joined["member"]["can_enroll"], true);
    let original_id = original["member"]["id"].as_str().unwrap();
    let joined_id = joined["member"]["id"].as_str().unwrap();
    let result = checked(
        &app,
        "PATCH",
        &format!("/v1/members/{joined_id}"),
        "/v1/members/{memberId}",
        Some(access(&original)),
        json!({"can_enroll":false}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(result["can_enroll"], true);
    checked(
        &app,
        "PATCH",
        &format!("/v1/members/{original_id}"),
        "/v1/members/{memberId}",
        Some(access(&joined)),
        json!({"role":"seller","can_enroll":false}),
        StatusCode::OK,
    )
    .await;
    checked(
        &app,
        "PATCH",
        "/v1/store",
        "/v1/store",
        Some(access(&original)),
        json!({"name":"denied after demotion"}),
        StatusCode::FORBIDDEN,
    )
    .await;
    let recovered = checked(
        &app,
        "POST",
        "/v1/auth/recover",
        "/v1/auth/recover",
        None,
        json!({"recovery_code":original["recovery_code"],"device":device()}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(recovered["member"]["id"], joined_id);
    checked(
        &app,
        "GET",
        "/v1/me",
        "/v1/me",
        Some(access(&original)),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    // Two concurrent attempts cannot remove every active Lead.
    checked(
        &app,
        "PATCH",
        &format!("/v1/members/{original_id}"),
        "/v1/members/{memberId}",
        Some(access(&joined)),
        json!({"role":"lead"}),
        StatusCode::OK,
    )
    .await;
    let input = json!({"role":"seller"});
    let original_path = format!("/v1/members/{original_id}");
    let joined_path = format!("/v1/members/{joined_id}");
    let (x, y) = tokio::join!(
        call(
            &app,
            "PATCH",
            &original_path,
            Some(access(&joined)),
            input.clone()
        ),
        call(&app, "PATCH", &joined_path, Some(access(&joined)), input)
    );
    assert_eq!(
        [x.0, y.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert!(
        [x.0, y.0]
            .iter()
            .any(|s| *s == StatusCode::CONFLICT || *s == StatusCode::FORBIDDEN)
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM members WHERE store_id=$1 AND active AND role='lead'",
    )
    .bind(
        original["store"]["id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap(),
    )
    .fetch_one(state.postgres.as_ref().unwrap())
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn recovery_refresh_and_logout_use_consistent_lock_order() {
    let (app, _) = setup().await;
    let lead = create(&app).await;
    let recover = json!({"recovery_code":lead["recovery_code"],"device":device(),"revoke_other_sessions":true});
    let refresh = json!({"refresh_token":lead["refresh_token"]});
    let (recovered, refreshed, logged_out) =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(
                call(&app, "POST", "/v1/auth/recover", None, recover),
                call(&app, "POST", "/v1/auth/refresh", None, refresh),
                call(
                    &app,
                    "POST",
                    "/v1/auth/logout",
                    Some(access(&lead)),
                    Value::Null
                )
            )
        })
        .await
        .expect("auth writes must not deadlock");
    assert_eq!(recovered.0, StatusCode::OK, "{}", recovered.1);
    assert!(
        [StatusCode::OK, StatusCode::UNAUTHORIZED].contains(&refreshed.0),
        "{refreshed:?}"
    );
    assert!(
        [StatusCode::NO_CONTENT, StatusCode::UNAUTHORIZED].contains(&logged_out.0),
        "{logged_out:?}"
    );
}
