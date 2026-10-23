use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use taphoa_api::{AppState, router};
use tower::ServiceExt;

#[tokio::test]
#[ignore = "real services required; DATABASE_URL and REDIS_URL"]
async fn real_dependencies_and_migration() {
    let (Ok(database_url), Ok(redis_url)) =
        (std::env::var("DATABASE_URL"), std::env::var("REDIS_URL"))
    else {
        eprintln!("SKIP readiness integration: set DATABASE_URL and REDIS_URL");
        return;
    };
    let state = AppState::connect(Some(&database_url), Some(&redis_url), None)
        .await
        .unwrap();
    let pool = state.postgres.clone().unwrap();
    let vector: String =
        sqlx::query_scalar("SELECT extname FROM pg_extension WHERE extname='vector'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(vector, "vector");
    let id: sqlx::types::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES ('integration fixture') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let app = router(state.clone());
    let response = app
        .clone()
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // A pool that cannot reach Postgres must name Postgres while Redis still answers.
    let bad_pool = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(100))
        .connect_lazy("postgres://test:test@127.0.0.1:1/test")
        .unwrap();
    let response = router(AppState {
        postgres: Some(bad_pool),
        ..state.clone()
    })
    .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["dependencies"], json!(["postgres"]));
    let response = router(AppState {
        redis: None,
        ..state
    })
    .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["dependencies"], json!(["redis"]));
    drop(app);
    pool.close().await;
}
