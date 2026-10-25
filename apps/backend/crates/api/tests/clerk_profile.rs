mod common;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use taphoa_api::auth::profile::ProfileClient;
use taphoa_api::config::ClerkSettings;
#[tokio::test]
#[ignore = "requires REDIS_URL"]
async fn profile_cache_and_failure_fallback() {
    let calls = Arc::new(AtomicUsize::new(0));
    async fn user(State(calls): State<Arc<AtomicUsize>>, headers: HeaderMap) -> Json<Value> {
        assert_eq!(headers["authorization"], "Bearer test-secret");
        calls.fetch_add(1, Ordering::SeqCst);
        Json(
            json!({"first_name":"  Lan ","last_name":"  Nguyễn  ","username":"fallback","primary_email_address_id":"primary","email_addresses":[{"id":"other","email_address":"wrong@example.com"},{"id":"primary","email_address":"lan@example.com"}]}),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/users/{id}", get(user))
                .route(
                    "/fail/v1/users/{id}",
                    get(|| async { StatusCode::BAD_GATEWAY }),
                )
                .with_state(calls.clone()),
        )
        .await
        .unwrap();
    });
    let redis = redis::Client::open(std::env::var("REDIS_URL").unwrap())
        .unwrap()
        .get_connection_manager()
        .await
        .unwrap();
    let settings = ClerkSettings {
        issuer: "unused".into(),
        jwks_url: "unused".into(),
        api_url: format!("http://{addr}"),
        authorized_parties: vec![],
        secret_key: Some("test-secret".into()),
    };
    let client = ProfileClient::new(&settings, reqwest::Client::new());
    let id = common::clerk::user();
    let profile = client.get(&id, Some(&redis)).await.unwrap();
    assert_eq!(profile.display_name.as_deref(), Some("Lan Nguyễn"));
    assert_eq!(profile.email.as_deref(), Some("lan@example.com"));
    task.abort(); // Cached reads continue after the HTTP server is gone.
    assert_eq!(client.get(&id, Some(&redis)).await, Some(profile));
    assert!(
        client
            .get(&common::clerk::user(), Some(&redis))
            .await
            .is_none()
    );
    let mut connection = redis.clone();
    let ttl: i64 = redis::cmd("TTL")
        .arg(format!("clerk:user:{id}"))
        .query_async(&mut connection)
        .await
        .unwrap();
    assert!((590..=600).contains(&ttl));
    assert!(
        ProfileClient::default()
            .get(&id, Some(&redis))
            .await
            .is_none()
    );
}
