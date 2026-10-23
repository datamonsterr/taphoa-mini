use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use taphoa_api::{
    AppState, router,
    storage::{ObjectStore, S3Store, StorageConfig},
};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn real_upload_reference_and_presigned_download() {
    let (Ok(database), Ok(redis)) = (std::env::var("DATABASE_URL"), std::env::var("REDIS_URL"))
    else {
        eprintln!("SKIP storage integration: set DATABASE_URL and REDIS_URL");
        return;
    };
    let Some(config) = StorageConfig::from_env().unwrap() else {
        eprintln!("SKIP storage integration: set all AWS_* storage variables");
        return;
    };
    let objects = Arc::new(S3Store::new(&config).await);
    if config.create_bucket {
        objects.ensure_bucket().await.unwrap();
    }
    let mut state = AppState::connect(Some(&database), Some(&redis), None)
        .await
        .unwrap();
    state.storage = Some(objects.clone());
    state.image_url_ttl = config.url_ttl;
    let pool = state.postgres.clone().unwrap();
    let app = router(state.clone());
    let readiness = app
        .clone()
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(readiness.status(), StatusCode::OK);
    let created = app
        .clone()
        .oneshot(
            Request::post("/v1/stores")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"store_name":"Storage test","display_name":"Lead","device":{"name":"test","platform":"android"}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: Value =
        serde_json::from_slice(&to_bytes(created.into_body(), 65536).await.unwrap()).unwrap();
    let store_id: Uuid = created["store"]["id"].as_str().unwrap().parse().unwrap();
    let bearer = format!("Bearer {}", created["access_token"].as_str().unwrap());
    let fixture = include_bytes!("../../../tests/fixtures/sample.png");
    let mut body = b"--test\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nenrollment\r\n--test\r\nContent-Disposition: form-data; name=\"image\"; filename=\"sample.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
    body.extend_from_slice(fixture);
    body.extend_from_slice(b"\r\n--test--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/images")
                .header("content-type", "multipart/form-data; boundary=test")
                .header("authorization", &bearer)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let uploaded: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    let id: Uuid = uploaded["id"].as_str().unwrap().parse().unwrap();
    let key = uploaded["object_key"].as_str().unwrap();
    let row: (i64, String, String, Option<Uuid>, String) = sqlx::query_as(
        "SELECT byte_size, object_key, content_type, store_id, purpose FROM images WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            fixture.len() as i64,
            key.into(),
            "image/png".into(),
            Some(store_id),
            "enrollment".into()
        )
    );
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/v1/images/{id}"))
                .header("authorization", &bearer)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let fetched: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    let downloaded = reqwest::get(fetched["url"].as_str().unwrap())
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&downloaded[..], fixture);
    assert_eq!(fetched["purpose"], json!("enrollment"));

    // A non-image payload is rejected before any row is written.
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM images")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut body = b"--test\r\nContent-Disposition: form-data; name=\"image\"\r\n\r\nnot an image\r\n--test--\r\n".to_vec();
    body.extend_from_slice(b"");
    let response = app
        .oneshot(
            Request::post("/v1/images")
                .header("content-type", "multipart/form-data; boundary=test")
                .header("authorization", &bearer)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM images")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    objects.delete(key).await.unwrap();
    sqlx::query("DELETE FROM images WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    drop(state);
    pool.close().await;
    assert_eq!(uploaded["content_type"], json!("image/png"));
}
