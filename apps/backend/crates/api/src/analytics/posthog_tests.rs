use super::*;
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;

async fn server(
    failures: usize,
) -> (
    String,
    mpsc::UnboundedReceiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    let (send, receive) = mpsc::unbounded_channel();
    let state = (send, Arc::new(AtomicUsize::new(0)), failures);
    let app = Router::new()
        .route(
            "/batch/",
            post(
                |State((send, count, failures)): State<(
                    mpsc::UnboundedSender<Value>,
                    Arc<AtomicUsize>,
                    usize,
                )>,
                 Json(body): Json<Value>| async move {
                    send.send(body).unwrap();
                    if count.fetch_add(1, Ordering::SeqCst) < failures {
                        StatusCode::INTERNAL_SERVER_ERROR
                    } else {
                        StatusCode::OK
                    }
                },
            ),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (host, receive, task)
}
fn config(host: String) -> PostHogConfig {
    PostHogConfig {
        token: "test-token".into(),
        host,
        environment: "test".into(),
        version: "abc123".into(),
    }
}
fn event() -> CaptureEvent {
    CaptureEvent {
        distinct_id: "member".into(),
        event: "sale_completed".into(),
        properties: Map::from_iter([
            ("total".into(), json!(5000)),
            ("environment".into(), json!("eval")),
        ]),
        groups: Map::from_iter([("store".into(), json!("store-id"))]),
        uuid: Some(Uuid::new_v5(&Uuid::NAMESPACE_OID, b"123")),
        timestamp: Some("2026-10-26T01:02:03Z".parse().unwrap()),
    }
}
#[tokio::test]
async fn batch_shape_properties_and_shutdown_flush() {
    let (host, mut received, task) = server(0).await;
    let sink = PostHogAnalytics::new(config(host));
    sink.capture_event(event()).await.unwrap();
    let mut second = event();
    second.environment_for_test();
    sink.capture_event(second).await.unwrap();
    sink.shutdown().await;
    let body = received.recv().await.unwrap();
    assert_eq!(body["api_key"], "test-token");
    assert_eq!(body["batch"].as_array().unwrap().len(), 2);
    let first = &body["batch"][0];
    assert_eq!(first["event"], "sale_completed");
    assert_eq!(first["distinct_id"], "member");
    assert_eq!(
        first["properties"],
        json!({"total":5000,"environment":"eval","app_version":"abc123","$lib":"taphoa-backend","$groups":{"store":"store-id"}})
    );
    assert_eq!(first["timestamp"], "2026-10-26T01:02:03Z");
    assert_eq!(first["uuid"], event().uuid.unwrap().to_string());
    assert_eq!(body["batch"][1]["properties"]["environment"], "test");
    assert!(body["batch"][1].get("uuid").is_none());
    assert!(
        chrono::DateTime::parse_from_rfc3339(body["batch"][1]["timestamp"].as_str().unwrap())
            .is_ok()
    );
    task.abort();
}
impl CaptureEvent {
    fn environment_for_test(&mut self) {
        self.properties.remove("environment");
        self.uuid = None;
        self.timestamp = None;
    }
}
#[tokio::test]
async fn retries_500_with_identical_batch() {
    let (host, mut received, task) = server(1).await;
    let sink = PostHogAnalytics::new(config(host));
    sink.capture_event(event()).await.unwrap();
    sink.shutdown().await;
    let first = received.recv().await.unwrap();
    assert_eq!(first, received.recv().await.unwrap());
    task.abort();
}
#[tokio::test]
async fn capture_never_waits_for_unavailable_server_or_full_queue() {
    let sink = PostHogAnalytics::new(config("http://127.0.0.1:1".into()));
    tokio::time::timeout(Duration::from_millis(200), async {
        for _ in 0..5000 {
            sink.capture_event(event()).await.unwrap();
        }
    })
    .await
    .unwrap();
    sink.shutdown().await;
}

#[tokio::test]
async fn flushes_at_one_hundred_and_then_on_interval() {
    let (host, mut received, task) = server(0).await;
    let sink = PostHogAnalytics::new(config(host));
    for _ in 0..101 {
        sink.capture_event(event()).await.unwrap();
    }
    let first = tokio::time::timeout(Duration::from_secs(1), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["batch"].as_array().unwrap().len(), 100);
    let second = tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second["batch"].as_array().unwrap().len(), 1);
    sink.shutdown().await;
    task.abort();
}
