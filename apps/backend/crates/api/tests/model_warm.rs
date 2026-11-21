mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::world::{World, send};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use taphoa_api::{AppState, model_holder::ModelHolder, router};
use taphoa_recognition::{Embedder, MockEmbedder, MockSegmenter, ocr::FakeReceiptOcr};
use tower::ServiceExt;

#[tokio::test]
async fn warm_requires_authentication() {
    let response = router(AppState::default())
        .oneshot(
            Request::post("/v1/recognition/warm")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL for store membership"]
async fn member_warm_is_idempotent_and_rate_limited() {
    let world = World::new().await;
    let mut state = world.state.clone();
    state.segmenter = Some(Arc::new(MockSegmenter { segments: vec![] }));
    state.receipt_ocr = Some(Arc::new(FakeReceiptOcr { lines: vec![] }));
    let loads = Arc::new(AtomicUsize::new(0));
    let count = loads.clone();
    state.models.dino = Some(ModelHolder::new(
        "fake-dino",
        Duration::from_secs(900),
        move || {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(MockEmbedder) as Arc<dyn Embedder>)
        },
    ));
    let app = router(state);
    for n in 0..6 {
        let response = send(
            &app,
            "POST",
            "/v1/recognition/warm",
            Some(&world.seller),
            Value::Null,
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        common::Contract::load().assert_conforms(
            "/v1/recognition/warm",
            "post",
            response.status,
            &response.body,
        );
        assert_eq!(response.body["dinov2"]["already_loaded"], n != 0);
    }
    assert_eq!(loads.load(Ordering::SeqCst), 1);
    let response = send(
        &app,
        "POST",
        "/v1/recognition/warm",
        Some(&world.seller),
        Value::Null,
    )
    .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers.contains_key("retry-after"));
}
