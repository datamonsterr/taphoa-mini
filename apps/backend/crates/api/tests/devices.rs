mod common;

use axum::http::StatusCode;
use common::{
    Contract,
    world::{World, send},
};
use serde_json::{Value, json};
use uuid::Uuid;

fn registration(token: &str) -> Value {
    json!({"token": token, "platform": "android", "app_version": "1.0", "language": "vi"})
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn registration_upserts_and_shared_phone_follows_latest_member() {
    let w = World::new().await;
    let token = format!("ExponentPushToken[{}]", Uuid::new_v4());
    let first = w
        .checked(
            "POST",
            "/v1/devices",
            "/v1/devices",
            &w.lead,
            registration(&token),
            StatusCode::OK,
        )
        .await;
    let second = w
        .checked(
            "POST",
            "/v1/devices",
            "/v1/devices",
            &w.seller,
            json!({"token":token,"platform":"ios","app_version":"2.0","language":"en"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(first["created_at"], second["created_at"]);
    assert!(second["updated_at"].as_str().unwrap() > first["updated_at"].as_str().unwrap());
    assert_eq!(second["language"], "en");
    let rows: Vec<(Uuid, Uuid)> =
        sqlx::query_as("SELECT member_id,store_id FROM devices WHERE token=$1")
            .bind(&token)
            .fetch_all(w.pool())
            .await
            .unwrap();
    assert_eq!(rows, vec![(w.seller_id, w.store_id)]);
    // A subsequent sign-in to another store transfers the same physical phone.
    let other = World::new().await;
    other
        .checked(
            "POST",
            "/v1/devices",
            "/v1/devices",
            &other.lead,
            registration(&token),
            StatusCode::OK,
        )
        .await;
    let row: (Uuid, Uuid) = sqlx::query_as("SELECT member_id,store_id FROM devices WHERE token=$1")
        .bind(&token)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(row, (other.lead_id, other.store_id));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn invalid_registration_is_validation_failed() {
    let w = World::new().await;
    for body in [
        json!({"token":"","platform":"android","app_version":"1","language":"vi"}),
        json!({"token":"x","platform":"web","app_version":"1","language":"vi"}),
        json!({"token":"x","platform":"ios","app_version":"1","language":"fr"}),
        json!({"token":"x","platform":"ios","language":"vi"}),
        json!({"token":"x","platform":"ios","app_version":"","language":"vi"}),
        json!({"token":"x","platform":"ios","app_version":"1","language":"vi","extra":true}),
    ] {
        let reply = w.call("POST", "/v1/devices", &w.lead, body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(reply.body["code"], "validation_failed");
        Contract::load().assert_conforms("/v1/devices", "post", reply.status, &reply.body);
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn delete_is_owner_scoped_url_decoded_and_idempotent() {
    let w = World::new().await;
    let token = format!("ExponentPushToken[{}]/+", Uuid::new_v4());
    w.checked(
        "POST",
        "/v1/devices",
        "/v1/devices",
        &w.lead,
        registration(&token),
        StatusCode::OK,
    )
    .await;
    let encoded: String = token.bytes().map(|b| format!("%{b:02X}")).collect();
    let path = format!("/v1/devices/{encoded}");
    let reply = w.call("DELETE", &path, &w.seller, Value::Null).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE token=$1)")
        .bind(&token)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert!(exists);
    for _ in 0..2 {
        let reply = w.call("DELETE", &path, &w.lead, Value::Null).await;
        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        assert!(reply.raw.is_empty());
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE token=$1)")
        .bind(&token)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert!(!exists);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn both_routes_require_authentication() {
    let w = World::new().await;
    for (method, path, body) in [
        ("POST", "/v1/devices", registration("x")),
        ("DELETE", "/v1/devices/x", Value::Null),
    ] {
        let reply = send(&w.app, method, path, None, body).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
}
