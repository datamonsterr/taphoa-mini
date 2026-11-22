use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use std::sync::{Arc, Mutex};
use taphoa_infer::{Models, Service};
use taphoa_recognition::{
    MockEmbedder, MockPointSegmenter, MockSegmenter,
    ocr::{FakeReceiptOcr, FakeTextDetector},
    wire::{self, CONTENT_TYPE, ImageRequest},
};
use tower::ServiceExt;

const TOKEN: &str = "access-log-test-token-with-at-least-32-characters";
fn fake() -> Models {
    Models {
        segmenter: Arc::new(MockSegmenter::default()),
        points: Arc::new(MockPointSegmenter::default()),
        embedder: Arc::new(MockEmbedder),
        detector: Arc::new(FakeTextDetector::default()),
        ocr: Arc::new(FakeReceiptOcr::default()),
    }
}
fn request(path: &str, token: Option<&str>, body: Vec<u8>) -> Request<Body> {
    Request::post(path)
        .header(header::CONTENT_TYPE, CONTENT_TYPE)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", token.unwrap_or_default()),
        )
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn access_log_records_metadata_once_without_token_or_payload() {
    #[derive(Clone)]
    struct Writer(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let captured = Arc::new(Mutex::new(Vec::new()));
    let output = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .with_writer(move || Writer(output.clone()))
        .finish();
    // A separate integration-test process keeps tracing's global callsite
    // cache independent of concurrent unit tests that use no subscriber.
    tracing::subscriber::set_global_default(subscriber).unwrap();
    let app = Service::new(fake(), TOKEN, "cpu").unwrap().router();
    let payload = b"private-image-payload".to_vec();
    // An invalid image still exercises body receipt and a complete access log.
    let body = wire::encode(&ImageRequest {
        image: payload.clone(),
    })
    .unwrap();
    let size = body.len();
    let response = app
        .oneshot(request("/v1/segment", Some(TOKEN), body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let logged = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
    assert_eq!(logged.lines().count(), 1);
    for expected in [
        "/v1/segment",
        "status=400",
        &format!("bytes_in={size}"),
        "duration_ms=",
    ] {
        assert!(logged.contains(expected), "missing {expected}: {logged}");
    }
    assert!(!logged.contains(TOKEN));
    assert!(!logged.contains(std::str::from_utf8(&payload).unwrap()));
}
