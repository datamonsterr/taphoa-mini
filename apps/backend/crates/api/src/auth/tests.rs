use super::crypto::*;
#[test]
fn invite_tokens_are_unique_and_hashed() {
    assert_ne!(invite_token(), invite_token());
    assert_eq!(
        hex::encode(token_hash("abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
#[tokio::test]
async fn password_hashes_are_argon2id_and_verify() {
    let hash = hash_secret("1234".into()).await.unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(verify_secret("1234".into(), hash.clone()).await.unwrap());
    assert!(!verify_secret("9999".into(), hash).await.unwrap());
}

#[tokio::test]
async fn pin_failure_counter_locks_and_success_resets() {
    use crate::{AppState, ratelimit::RateLimiter};
    use std::sync::Arc;
    let limiter = Arc::new(crate::ratelimit::MemoryRateLimiter::default());
    let state = AppState {
        rate_limiter: limiter.clone(),
        ..AppState::default()
    };
    let id = uuid::Uuid::new_v4();
    let hash = hash_secret("1234".into()).await.unwrap();
    for _ in 0..4 {
        assert_eq!(
            super::handlers::verify_pin(&state, id, Some("9999".into()), hash.clone())
                .await
                .unwrap_err()
                .code,
            "invalid_pin"
        );
    }
    super::handlers::verify_pin(&state, id, Some("1234".into()), hash.clone())
        .await
        .unwrap();
    for _ in 0..4 {
        assert_eq!(
            super::handlers::verify_pin(&state, id, None, hash.clone())
                .await
                .unwrap_err()
                .code,
            "invalid_pin"
        );
    }
    let error = super::handlers::verify_pin(&state, id, None, hash.clone())
        .await
        .unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        super::handlers::verify_pin(&state, id, Some("1234".into()), hash.clone())
            .await
            .unwrap_err()
            .status,
        axum::http::StatusCode::TOO_MANY_REQUESTS
    );
    limiter.reset(&format!("pin_fail:{id}:lock")).await.unwrap();
    limiter.reset(&format!("pin_fail:{id}")).await.unwrap();
    super::handlers::verify_pin(&state, id, Some("1234".into()), hash)
        .await
        .unwrap();
}

/// Records the order of limiter calls around the real in-memory limiter.
#[derive(Default)]
struct Recording {
    inner: crate::ratelimit::MemoryRateLimiter,
    log: std::sync::Mutex<Vec<String>>,
}
#[async_trait::async_trait]
impl crate::ratelimit::RateLimiter for Recording {
    async fn check(&self, key: &str, limit: u32) -> anyhow::Result<crate::ratelimit::RateDecision> {
        self.log.lock().unwrap().push(format!("check {key}"));
        self.inner.check(key, limit).await
    }
    async fn reset(&self, key: &str) -> anyhow::Result<()> {
        self.log.lock().unwrap().push(format!("reset {key}"));
        self.inner.reset(key).await
    }
    async fn hit(
        &self,
        key: &str,
        limit: u32,
        window: std::time::Duration,
    ) -> anyhow::Result<crate::ratelimit::RateDecision> {
        self.log.lock().unwrap().push(format!("hit {key}"));
        self.inner.hit(key, limit, window).await
    }
}

#[tokio::test]
async fn a_pin_attempt_is_counted_before_it_is_verified_and_reset_on_success() {
    use crate::{AppState, ratelimit::RateLimiter as _};
    use std::sync::Arc;
    let limiter = Arc::new(Recording::default());
    let state = AppState {
        rate_limiter: limiter.clone(),
        ..AppState::default()
    };
    let id = uuid::Uuid::new_v4();
    let hash = hash_secret("1234".into()).await.unwrap();
    super::handlers::verify_pin(&state, id, Some("1234".into()), hash)
        .await
        .unwrap();
    let key = format!("pin_fail:{id}");
    let log = limiter.log.lock().unwrap().clone();
    let position = |entry: String| log.iter().position(|logged| *logged == entry);
    let hit = position(format!("hit {key}")).expect("the attempt is counted");
    let reset = position(format!("reset {key}")).expect("success resets the counter");
    assert!(hit < reset, "{log:?}");
    assert!(limiter.inner.check(&key, 0).await.unwrap().allowed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_pin_attempts_never_exceed_the_cap() {
    use crate::AppState;
    let state = AppState::default();
    let cap = state.rate_limits.pin_attempts as usize;
    let id = uuid::Uuid::new_v4();
    let hash = hash_secret("1234".into()).await.unwrap();
    // Every request passes the lock check before any verification finishes, so the
    // attempt has to be counted first or all of them would be verified.
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..cap * 3 {
        let (state, hash) = (state.clone(), hash.clone());
        requests.spawn(async move {
            super::handlers::verify_pin(&state, id, Some("1234".into()), hash).await
        });
    }
    let (mut verified, mut limited) = (0, 0);
    while let Some(result) = requests.join_next().await {
        match result.unwrap() {
            Ok(()) => verified += 1,
            Err(error) => {
                assert_eq!(error.status, axum::http::StatusCode::TOO_MANY_REQUESTS);
                limited += 1;
            }
        }
    }
    assert!(
        (1..=cap).contains(&verified),
        "{verified} verified, cap {cap}"
    );
    assert_eq!(verified + limited, cap * 3);
}

#[tokio::test]
async fn legacy_session_routes_are_removed() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    for path in [
        "/v1/auth/recover",
        "/v1/auth/refresh",
        "/v1/auth/switch",
        "/v1/auth/logout",
    ] {
        let response = crate::router(crate::AppState::default())
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}
