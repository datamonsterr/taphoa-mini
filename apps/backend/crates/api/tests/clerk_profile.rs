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
    atomic::{AtomicU16, AtomicUsize, Ordering},
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
    let stub_calls = calls.clone();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/users/{id}", get(user))
                .route(
                    "/fail/v1/users/{id}",
                    get(|| async { StatusCode::BAD_GATEWAY }),
                )
                .with_state(stub_calls),
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
    assert_eq!(client.get(&id, Some(&redis)).await, Some(profile.clone()));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "cache hit must not call Clerk twice"
    );
    let mut failed_settings = settings.clone();
    failed_settings.api_url = format!("http://{addr}/fail");
    assert!(
        ProfileClient::new(&failed_settings, reqwest::Client::new())
            .get("failure", Some(&redis))
            .await
            .is_none()
    );
    let mut missing_secret = settings.clone();
    missing_secret.secret_key = None;
    assert!(
        ProfileClient::new(&missing_secret, reqwest::Client::new())
            .get(&id, Some(&redis))
            .await
            .is_none()
    );
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

#[tokio::test]
#[ignore = "requires REDIS_URL"]
async fn clerk_failures_are_cached_in_redis_for_every_instance() {
    #[derive(Clone)]
    struct Clerk {
        calls: Arc<AtomicUsize>,
        status: Arc<AtomicU16>,
    }
    async fn user(State(clerk): State<Clerk>) -> (StatusCode, Json<Value>) {
        clerk.calls.fetch_add(1, Ordering::SeqCst);
        let status = StatusCode::from_u16(clerk.status.load(Ordering::SeqCst)).unwrap();
        (
            status,
            Json(json!({"first_name":"Lan","primary_email_address_id":null,"email_addresses":[]})),
        )
    }
    let clerk = Clerk {
        calls: Arc::new(AtomicUsize::new(0)),
        status: Arc::new(AtomicU16::new(429)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = clerk.clone();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/users/{id}", get(user))
                .with_state(state),
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
    let id = common::clerk::user();
    let first = ProfileClient::new(&settings, reqwest::Client::new());
    assert!(first.get(&id, Some(&redis)).await.is_none());
    assert!(first.get(&id, Some(&redis)).await.is_none());
    // A second instance has its own memory and shares only Redis.
    let second = ProfileClient::new(&settings, reqwest::Client::new());
    assert!(second.get(&id, Some(&redis)).await.is_none());
    assert_eq!(
        clerk.calls.load(Ordering::SeqCst),
        1,
        "one failed Clerk call is shared"
    );
    let mut connection = redis.clone();
    let profile_key: Option<String> = redis::cmd("GET")
        .arg(format!("clerk:user:{id}"))
        .query_async(&mut connection)
        .await
        .unwrap();
    assert!(
        profile_key.is_none(),
        "a failure never uses the profile key"
    );

    // The failure marker expires, then Clerk is asked again and the profile is cached.
    let id = common::clerk::user();
    clerk.status.store(500, Ordering::SeqCst);
    let brief = ProfileClient::new(&settings, reqwest::Client::new())
        .with_failure_ttl(std::time::Duration::from_secs(1));
    assert!(brief.get(&id, Some(&redis)).await.is_none());
    clerk.status.store(200, Ordering::SeqCst);
    assert!(
        brief.get(&id, Some(&redis)).await.is_none(),
        "still remembered"
    );
    tokio::time::sleep(std::time::Duration::from_millis(1300)).await;
    let profile = brief.get(&id, Some(&redis)).await.expect("Clerk recovered");
    assert_eq!(profile.display_name.as_deref(), Some("Lan"));
    task.abort();
}
