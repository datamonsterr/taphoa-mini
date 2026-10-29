mod common;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use chrono::{DateTime, Utc};
use common::world::World;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use taphoa_api::{
    devices::Device,
    push::{ExpoPush, PushApi, PushConfig, PushMessage, check_receipts, send_to_devices},
};
use uuid::Uuid;

type TicketRow = (String, String, Option<String>, Option<DateTime<Utc>>);

#[derive(Clone, Default)]
struct MockState {
    requests: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
    responses: Arc<Mutex<VecDeque<(StatusCode, Value)>>>,
}
struct MockExpo {
    state: MockState,
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for MockExpo {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl MockExpo {
    async fn new(responses: Vec<(StatusCode, Value)>) -> Self {
        async fn send(
            State(state): State<MockState>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            respond(state, headers, body, "send")
        }
        async fn receipts(
            State(state): State<MockState>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            respond(state, headers, body, "getReceipts")
        }
        fn respond(
            state: MockState,
            headers: HeaderMap,
            body: Value,
            path: &str,
        ) -> (StatusCode, Json<Value>) {
            state
                .requests
                .lock()
                .unwrap()
                .push((path.to_owned(), headers, body.clone()));
            if let Some((status, response)) = state.responses.lock().unwrap().pop_front() {
                return (status, Json(response));
            }
            let response = if path == "send" {
                json!({"data":body.as_array().unwrap().iter().map(|_| json!({"status":"ok","id":Uuid::new_v4().to_string()})).collect::<Vec<_>>()})
            } else {
                json!({"data":{}})
            };
            (StatusCode::OK, Json(response))
        }
        let state = MockState::default();
        state.responses.lock().unwrap().extend(responses);
        let app = Router::new()
            .route("/send", post(send))
            .route("/getReceipts", post(receipts))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { state, url, task }
    }
    fn api(&self, token: Option<&str>) -> ExpoPush {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut config = PushConfig::from_lookup(|key| match key {
            "EXPO_PUSH_URL" => Some(self.url.clone()),
            "EXPO_ACCESS_TOKEN" => token.map(str::to_owned),
            _ => None,
        })
        .unwrap();
        config.backoff_base = Duration::from_millis(100);
        ExpoPush::new(config).unwrap()
    }
}
fn message(device: &Device) -> PushMessage {
    message_to(&device.token)
}
fn message_to(token: &str) -> PushMessage {
    PushMessage {
        to: token.into(),
        title: "Digest".into(),
        body: "Summary".into(),
        data: json!({"url":"/digest?entry=push"}),
        channel_id: "digest".into(),
        priority: "high".into(),
        sound: Some("default".into()),
    }
}
async fn devices(w: &World, count: usize) -> Vec<String> {
    let tokens: Vec<_> = (0..count)
        .map(|_| format!("ExpoPushToken[{}]", Uuid::new_v4()))
        .collect();
    sqlx::query("INSERT INTO devices(token,store_id,member_id,platform,app_version,language) SELECT unnest($1::text[]),$2,$3,'android','1','vi'")
        .bind(&tokens).bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    tokens
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sends_150_devices_in_ordered_batches_and_persists_pending_tickets() {
    let w = World::new().await;
    devices(&w, 150).await;
    let mock = MockExpo::new(vec![]).await;
    let report = send_to_devices(
        w.pool(),
        &mock.api(None),
        w.store_id,
        Utc::now().date_naive(),
        message,
    )
    .await
    .unwrap();
    assert_eq!(
        (report.sent, report.failed, report.unregistered),
        (150, 0, 0)
    );
    let requests = mock.state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].2.as_array().unwrap().len(), 100);
    assert_eq!(requests[1].2.as_array().unwrap().len(), 50);
    for (path, headers, body) in requests.iter() {
        assert_eq!(path, "send");
        assert_eq!(headers["accept"], "application/json");
        assert_eq!(headers["content-type"], "application/json");
        assert!(!headers.contains_key("authorization"));
        assert_eq!(body[0]["channelId"], "digest");
        assert_eq!(body[0]["priority"], "high");
        assert_eq!(body[0]["sound"], "default");
    }
    drop(requests);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM push_tickets WHERE store_id=$1 AND status='pending_receipt' AND ticket_id IS NOT NULL")
        .bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    assert_eq!(count, 150);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn unregistered_ticket_deletes_device_and_records_error() {
    let w = World::new().await;
    let tokens = devices(&w, 1).await;
    let mock = MockExpo::new(vec![(StatusCode::OK,json!({"data":[{"status":"error","message":"private token must not be logged","details":{"error":"DeviceNotRegistered"}}]}))]).await;
    let report = send_to_devices(
        w.pool(),
        &mock.api(None),
        w.store_id,
        Utc::now().date_naive(),
        message,
    )
    .await
    .unwrap();
    assert_eq!((report.sent, report.failed, report.unregistered), (0, 1, 1));
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE token=$1)")
        .bind(&tokens[0])
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert!(!exists);
    let row: (String, String) =
        sqlx::query_as("SELECT status,error_code FROM push_tickets WHERE store_id=$1")
            .bind(w.store_id)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(row, ("error".into(), "DeviceNotRegistered".into()));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn authorization_is_optional_and_500_and_429_are_retried() {
    for status in [
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::TOO_MANY_REQUESTS,
    ] {
        let mock = MockExpo::new(vec![(status, json!({"errors":[{"code":"temporary"}]}))]).await;
        let tickets = mock
            .api(Some("test-access-secret"))
            .send(&[message_to("test-device")])
            .await
            .unwrap();
        assert_eq!(tickets.len(), 1);
        let requests = mock.state.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].1["authorization"], "Bearer test-access-secret");
        assert_eq!(requests[0].2, requests[1].2);
    }
    let mock = MockExpo::new(vec![]).await;
    mock.api(None)
        .send(&[message_to("test-device")])
        .await
        .unwrap();
    assert!(
        !mock.state.requests.lock().unwrap()[0]
            .1
            .contains_key("authorization")
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn permanent_http_errors_expose_code_without_retry_and_retries_stop_after_three_attempts() {
    let mock = MockExpo::new(vec![(
        StatusCode::BAD_REQUEST,
        json!({"errors":[{"code":"PUSH_TOO_MANY_EXPERIENCE_IDS","message":"private"}]}),
    )])
    .await;
    let error = mock
        .api(None)
        .send(&[message_to("test-device")])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("PUSH_TOO_MANY_EXPERIENCE_IDS"));
    assert!(!error.to_string().contains("private"));
    assert_eq!(mock.state.requests.lock().unwrap().len(), 1);
    let mock = MockExpo::new(vec![(StatusCode::INTERNAL_SERVER_ERROR, json!({})); 3]).await;
    assert!(
        mock.api(None)
            .send(&[message_to("test-device")])
            .await
            .is_err()
    );
    assert_eq!(mock.state.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn adapter_batches_receipts_at_1000_and_sends_at_100() {
    let mock = MockExpo::new(vec![]).await;
    let api = mock.api(Some("test-secret"));
    let messages: Vec<_> = (0..150).map(|_| message_to("test-device")).collect();
    assert_eq!(api.send(&messages).await.unwrap().len(), 150);
    let ids: Vec<_> = (0..1001).map(|i| i.to_string()).collect();
    assert!(api.receipts(&ids).await.unwrap().is_empty());
    let requests = mock.state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[2].0, "getReceipts");
    assert_eq!(requests[2].2["ids"].as_array().unwrap().len(), 1000);
    assert_eq!(requests[3].2["ids"].as_array().unwrap().len(), 1);
    assert_eq!(requests[2].1["authorization"], "Bearer test-secret");
    drop(requests);
    assert!(api.send(&[]).await.unwrap().is_empty());
    assert!(api.receipts(&[]).await.unwrap().is_empty());
    assert_eq!(mock.state.requests.lock().unwrap().len(), 4);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn receipts_update_status_cleanup_tokens_respect_min_age_and_expire_missing() {
    let w = World::new().await;
    let tokens = devices(&w, 5).await;
    // A past clock isolates this global receipt scan from other suites' current rows.
    let now: DateTime<Utc> = "2020-01-03T12:00:00Z".parse().unwrap();
    for (i, age) in [20, 20, 5, 1500, 20].iter().enumerate() {
        sqlx::query("INSERT INTO push_tickets(store_id,token,business_date,ticket_id,status,created_at) VALUES ($1,$2,$3,$4,'pending_receipt',$5)")
            .bind(w.store_id).bind(&tokens[i]).bind(now.date_naive()).bind(format!("receipt-{i}"))
            .bind(now-chrono::Duration::minutes(*age)).execute(w.pool()).await.unwrap();
    }
    let mock = MockExpo::new(vec![(
        StatusCode::OK,
        json!({"data":{
            "receipt-0":{"status":"ok"},
            "receipt-1":{"status":"error","details":{"error":"DeviceNotRegistered"}}
        }}),
    )])
    .await;
    let report = check_receipts(w.pool(), &mock.api(None), Duration::from_secs(900), now)
        .await
        .unwrap();
    assert_eq!(
        (
            report.ok,
            report.errors,
            report.unregistered,
            report.missing
        ),
        (1, 1, 1, 1)
    );
    let rows: Vec<TicketRow> = sqlx::query_as("SELECT ticket_id,status,error_code,checked_at FROM push_tickets WHERE store_id=$1 ORDER BY ticket_id")
        .bind(w.store_id).fetch_all(w.pool()).await.unwrap();
    assert_eq!(rows[0].1, "receipt_ok");
    assert_eq!(rows[1].1, "receipt_error");
    assert_eq!(rows[1].2.as_deref(), Some("DeviceNotRegistered"));
    assert_eq!(rows[2].1, "pending_receipt");
    assert_eq!(rows[3].1, "receipt_error");
    assert_eq!(rows[3].2.as_deref(), Some("missing"));
    assert_eq!(rows[4].1, "pending_receipt");
    for i in [0, 1, 3] {
        assert_eq!(rows[i].3, Some(now));
    }
    assert!(rows[2].3.is_none());
    let remaining: Vec<String> = sqlx::query_scalar("SELECT token FROM devices WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_all(w.pool())
        .await
        .unwrap();
    assert_eq!(remaining.len(), 4);
    assert!(!remaining.contains(&tokens[1]));
    let requests = mock.state.requests.lock().unwrap().clone();
    let ids = requests[0].2["ids"].as_array().unwrap();
    assert!(!ids.contains(&json!("receipt-2")));
    assert_eq!(ids.len(), 4);
    drop(requests);
    // Remove only this test's outstanding rows so subsequent global scans are isolated.
    sqlx::query("DELETE FROM push_tickets WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn adapter_rejects_malformed_ticket_counts_and_missing_ok_id() {
    for data in [
        json!([]),
        json!([{"status":"ok"}]),
        json!([{"status":"unknown"}]),
    ] {
        let mock = MockExpo::new(vec![(StatusCode::OK, json!({"data":data}))]).await;
        assert!(
            mock.api(None)
                .send(&[message_to("test-device")])
                .await
                .is_err()
        );
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn unknown_receipt_status_marks_error_and_keeps_processing_batch() {
    let w = World::new().await;
    let tokens = devices(&w, 2).await;
    let now: DateTime<Utc> = "2019-01-03T12:00:00Z".parse().unwrap();
    for (i, token) in tokens.iter().enumerate() {
        sqlx::query("INSERT INTO push_tickets(store_id,token,business_date,ticket_id,status,created_at) VALUES($1,$2,$3,$4,'pending_receipt',$5)")
            .bind(w.store_id).bind(token).bind(now.date_naive()).bind(format!("invalid-receipt-{i}"))
            .bind(now-chrono::Duration::minutes(20)).execute(w.pool()).await.unwrap();
    }
    let mock = MockExpo::new(vec![(
        StatusCode::OK,
        json!({"data":{
            "invalid-receipt-0":{"status":"unexpected","details":{"error":"DeviceNotRegistered"}},
            "invalid-receipt-1":{"status":"ok"}
        }}),
    )])
    .await;
    let report = check_receipts(w.pool(), &mock.api(None), Duration::from_secs(900), now)
        .await
        .unwrap();
    assert_eq!((report.ok, report.errors, report.unregistered), (1, 1, 0));
    let rows: Vec<TicketRow> = sqlx::query_as("SELECT ticket_id,status,error_code,checked_at FROM push_tickets WHERE store_id=$1 ORDER BY ticket_id")
        .bind(w.store_id).fetch_all(w.pool()).await.unwrap();
    assert_eq!(rows[0].1, "receipt_error");
    assert_eq!(rows[0].2.as_deref(), Some("invalid_status"));
    assert_eq!(rows[0].3, Some(now));
    assert_eq!(rows[1].1, "receipt_ok");
    assert_eq!(rows[1].3, Some(now));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(count, 2);
    sqlx::query("DELETE FROM push_tickets WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
}

#[tokio::test]
async fn send_does_not_retry_transport_failure_after_server_received_body() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let received = Arc::new(AtomicUsize::new(0));
    let count = received.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
                if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            count.fetch_add(1, Ordering::SeqCst);
            // The body was received, but the peer fails before a valid HTTP response.
            stream.write_all(b"HTTP/1.1 invalid\r\n\r\n").await.unwrap();
        }
    });
    let api = ExpoPush::new(PushConfig {
        url,
        access_token: None,
        backoff_base: Duration::from_millis(1),
    })
    .unwrap();
    let result = api
        .send(&[message_to("ExpoPushToken[transport-test]")])
        .await;
    server.abort();
    assert!(result.is_err());
    assert_eq!(
        received.load(Ordering::SeqCst),
        1,
        "received POST must not be replayed"
    );
}

/// #146: a removed member's phone gets nothing, and the token is dropped when they are removed.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn removed_member_devices_are_dropped_and_never_selected() {
    let w = World::new().await;
    let lead_token = devices(&w, 1).await.remove(0);
    let seller_token = format!("ExpoPushToken[{}]", Uuid::new_v4());
    let other_seller = format!("ExpoPushToken[{}]", Uuid::new_v4());
    for (token, member) in [(&seller_token, w.seller_id), (&other_seller, w.seller_id)] {
        sqlx::query("INSERT INTO devices(token,store_id,member_id,platform,app_version,language) VALUES($1,$2,$3,'android','1','vi')")
            .bind(token).bind(w.store_id).bind(member).execute(w.pool()).await.unwrap();
    }
    let removed = w
        .call(
            "DELETE",
            &format!("/v1/members/{}", w.seller_id),
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
    let left: Vec<String> = sqlx::query_scalar("SELECT token FROM devices WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_all(w.pool())
        .await
        .unwrap();
    assert_eq!(
        left,
        vec![lead_token.clone()],
        "removal deletes the member's devices"
    );
    // Defence in depth: a token that survives (race, stale row) is still skipped while inactive.
    sqlx::query("INSERT INTO devices(token,store_id,member_id,platform,app_version,language) VALUES($1,$2,$3,'android','1','vi')")
        .bind(&seller_token).bind(w.store_id).bind(w.seller_id).execute(w.pool()).await.unwrap();
    let mock = MockExpo::new(vec![]).await;
    let report = send_to_devices(
        w.pool(),
        &mock.api(None),
        w.store_id,
        Utc::now().date_naive(),
        message,
    )
    .await
    .unwrap();
    assert_eq!(report.sent, 1);
    let requests = mock.state.requests.lock().unwrap().clone();
    let sent: Vec<&str> = requests[0]
        .2
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["to"].as_str().unwrap())
        .collect();
    assert_eq!(sent, vec![lead_token.as_str()]);
}
