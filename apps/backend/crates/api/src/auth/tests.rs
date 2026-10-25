use super::crypto::*;
#[test]
fn recovery_format_normalization_and_hashing() {
    for _ in 0..32 {
        let code = recovery_code();
        assert_eq!(code.len(), 19);
        let groups: Vec<_> = code.split('-').collect();
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|x| x.len() == 4));
        assert!(
            code.bytes()
                .all(|c| c == b'-' || RECOVERY_ALPHABET.contains(&c))
        );
        assert_eq!(
            normalize_recovery(&code.to_lowercase().replace('-', " ")),
            code.replace('-', "")
        );
    }
    assert_eq!(
        hex::encode(token_hash("abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_ne!(token_hash(&opaque_token()), token_hash(&opaque_token()));
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
