//! Outbox relay, Redis fan-out and the SSE endpoint against real Postgres and Redis.
//!
//! Public surface these tests pin down:
//! - `events::relay::spawn(pool, redis_url, shutdown_rx, analytics) -> JoinHandle<()>`
//! - `events::Hub::{new, with_heartbeat(Duration)}` and `AppState.hub`
//! - `events::spawn_background(&AppState, shutdown_rx) -> Vec<JoinHandle<()>>` (relay + hub subscriber)
mod common;
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{net::SocketAddr, time::Duration};
use taphoa_api::{
    AppState,
    config::Config,
    events::{Event, Hub, emit, relay, spawn_background},
    router,
};
use tokio::{sync::watch, task::JoinHandle, time::timeout};
use uuid::Uuid;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"))
}
async fn pool() -> PgPool {
    PgPool::connect(&env("DATABASE_URL")).await.unwrap()
}
async fn new_store(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id,name) VALUES ($1,'stream')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}
async fn cleanup(pool: &PgPool, store: Uuid) {
    // Other suites assert invariants over every outbox row, so leave none behind.
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(store)
        .execute(pool)
        .await
        .unwrap();
}
async fn emit_store_changed(pool: &PgPool, store: Uuid, field: &str) -> (i64, Value) {
    let mut tx = pool.begin().await.unwrap();
    let e = emit(
        &mut tx,
        Event {
            store_id: store,
            actor: None,
            typ: "store.changed",
            version: 1,
            data: json!({"fields":[field]}),
            change: Some(("store", store, "upsert")),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (e.id, e.payload)
}
async fn published(pool: &PgPool, id: i64) -> bool {
    sqlx::query_scalar("SELECT published_at IS NOT NULL FROM outbox_events WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn eventually<F: std::future::Future<Output = bool>>(mut f: impl FnMut() -> F) {
    for _ in 0..100 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("condition not reached in 5 s");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn relay_publishes_committed_events_in_order_and_marks_published() {
    let pool = pool().await;
    let store = new_store(&pool).await;
    let client = redis::Client::open(env("REDIS_URL")).unwrap();
    let mut sub = client.get_async_pubsub().await.unwrap();
    sub.psubscribe(format!("store:{store}:events"))
        .await
        .unwrap();
    let (shutdown, rx) = watch::channel(false);
    let handle = relay::spawn(
        pool.clone(),
        env("REDIS_URL"),
        rx,
        std::sync::Arc::new(taphoa_api::analytics::NoopAnalytics),
    );

    let (first, p1) = emit_store_changed(&pool, store, "a").await;
    let (second, p2) = emit_store_changed(&pool, store, "b").await;
    let mut stream = sub.on_message();
    for expected in [&p1, &p2] {
        let msg = timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(msg.get_channel_name(), format!("store:{store}:events"));
        let got: Value = serde_json::from_str(&msg.get_payload::<String>().unwrap()).unwrap();
        assert_eq!(&got, expected);
    }
    eventually(|| async { published(&pool, first).await && published(&pool, second).await }).await;

    shutdown.send(true).unwrap();
    timeout(Duration::from_secs(3), handle)
        .await
        .expect("relay stops on shutdown")
        .unwrap();
    cleanup(&pool, store).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn relay_keeps_events_when_redis_is_down_then_delivers_at_least_once() {
    let pool = pool().await;
    let store = new_store(&pool).await;
    let (id, payload) = emit_store_changed(&pool, store, "a").await;

    // Nothing listens on port 1: every publish fails, so the row must stay unpublished.
    let (stop_bad, rx) = watch::channel(false);
    let bad = relay::spawn(
        pool.clone(),
        "redis://127.0.0.1:1".into(),
        rx,
        std::sync::Arc::new(taphoa_api::analytics::NoopAnalytics),
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!published(&pool, id).await);
    stop_bad.send(true).unwrap();
    timeout(Duration::from_secs(3), bad)
        .await
        .expect("stops while backing off")
        .unwrap();

    let client = redis::Client::open(env("REDIS_URL")).unwrap();
    let mut sub = client.get_async_pubsub().await.unwrap();
    sub.psubscribe(format!("store:{store}:events"))
        .await
        .unwrap();
    let (stop, rx) = watch::channel(false);
    let good = relay::spawn(
        pool.clone(),
        env("REDIS_URL"),
        rx,
        std::sync::Arc::new(taphoa_api::analytics::NoopAnalytics),
    );
    let msg = timeout(Duration::from_secs(10), sub.on_message().next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&msg.get_payload::<String>().unwrap()).unwrap(),
        payload
    );
    eventually(|| async { published(&pool, id).await }).await;
    stop.send(true).unwrap();
    good.await.unwrap();
    cleanup(&pool, store).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn two_relays_never_publish_the_same_row_twice_in_parallel() {
    let pool = pool().await;
    let store = new_store(&pool).await;
    let client = redis::Client::open(env("REDIS_URL")).unwrap();
    let mut sub = client.get_async_pubsub().await.unwrap();
    sub.psubscribe(format!("store:{store}:events"))
        .await
        .unwrap();
    let (stop, rx) = watch::channel(false);
    let a = relay::spawn(
        pool.clone(),
        env("REDIS_URL"),
        rx.clone(),
        std::sync::Arc::new(taphoa_api::analytics::NoopAnalytics),
    );
    let b = relay::spawn(
        pool.clone(),
        env("REDIS_URL"),
        rx,
        std::sync::Arc::new(taphoa_api::analytics::NoopAnalytics),
    );
    let mut ids = Vec::new();
    for n in 0..20 {
        ids.push(emit_store_changed(&pool, store, &format!("f{n}")).await.0);
    }
    let mut seen = std::collections::HashSet::new();
    let mut stream = sub.on_message();
    while seen.len() < 20 {
        let msg = timeout(Duration::from_secs(10), stream.next())
            .await
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_str(&msg.get_payload::<String>().unwrap()).unwrap();
        assert!(
            seen.insert(v["id"].as_str().unwrap().to_string()),
            "SKIP LOCKED: no duplicate delivery"
        );
    }
    stop.send(true).unwrap();
    let _ = tokio::join!(a, b);
    cleanup(&pool, store).await;
}

// ---------------------------------------------------------------- SSE

struct Server {
    base: String,
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
async fn start() -> (Server, AppState) {
    start_with(Hub::with_heartbeat(Duration::from_millis(300))).await
}
async fn start_with(hub: Hub) -> (Server, AppState) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = Config::from_lookup(|key| match key {
        "CLERK_ISSUER" => Some(common::clerk::TEST_ISSUER.into()),
        "CLERK_SECRET_KEY" => None,
        "RATE_LIMIT_STORE_CREATE_PER_HOUR" | "RATE_LIMIT_JOIN_PER_HOUR" => Some("100000".into()),
        _ => std::env::var(key).ok(),
    })
    .unwrap();
    let mut state = AppState::connect_with_config(&config, None).await.unwrap();
    common::clerk::install(&mut state);
    state.hub = hub;
    let (shutdown, rx) = watch::channel(false);
    let mut tasks = spawn_background(&state, rx.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = router(state.clone());
    let mut rx2 = rx;
    tasks.push(tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = rx2.changed().await;
        })
        .await
        .unwrap();
    }));
    (
        Server {
            base,
            shutdown,
            tasks,
        },
        state,
    )
}
impl Server {
    async fn stop(self) {
        self.shutdown.send(true).unwrap();
        for task in self.tasks {
            timeout(Duration::from_secs(5), task)
                .await
                .expect("task stops on shutdown")
                .unwrap();
        }
    }
}
async fn create_store(base: &str) -> Value {
    let token = common::clerk::token();
    let response = taphoa_api::http_client()
        .post(format!("{base}/v1/stores"))
        .bearer_auth(&token)
        .json(&json!({"store_name":"SSE","display_name":"Lead"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    let mut body: Value = response.json().await.unwrap();
    body["access_token"] = json!(token);
    body
}

async fn open(base: &str, token: &str, last_event_id: Option<&str>) -> reqwest::Response {
    let mut request = taphoa_api::http_client()
        .get(format!("{base}/v1/events"))
        .bearer_auth(token);
    if let Some(id) = last_event_id {
        request = request.header("Last-Event-ID", id);
    }
    request.send().await.unwrap()
}
/// Next complete SSE frame (blank-line terminated), including comment-only frames.
async fn frame(response: &mut reqwest::Response, buf: &mut String) -> String {
    loop {
        if let Some(end) = buf.find("\n\n") {
            let frame = buf[..end].to_string();
            buf.drain(..end + 2);
            return frame;
        }
        let chunk = timeout(Duration::from_secs(8), response.chunk())
            .await
            .expect("SSE frame within 8 s")
            .unwrap()
            .expect("stream open");
        buf.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
    }
}
/// Skip heartbeat frames and return the next event frame as (id, event, data).
async fn event(response: &mut reqwest::Response, buf: &mut String) -> (String, String, Value) {
    loop {
        let f = frame(response, buf).await;
        if f.lines().all(|l| l.starts_with(':')) {
            continue;
        }
        let field = |name: &str| {
            f.lines()
                .find_map(|l| l.strip_prefix(&format!("{name}: ")))
                .unwrap_or_else(|| panic!("frame lacks {name}: {f}"))
                .to_string()
        };
        return (
            field("id"),
            field("event"),
            serde_json::from_str(&field("data")).unwrap(),
        );
    }
}
async fn patch_store(base: &str, token: &str, name: &str) {
    let response = taphoa_api::http_client()
        .patch(format!("{base}/v1/store"))
        .bearer_auth(token)
        .json(&json!({"name":name}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn store_patch_reaches_the_sse_client_and_stays_inside_its_store() {
    let (server, _) = start().await;
    let a = create_store(&server.base).await;
    let b = create_store(&server.base).await;
    let (ta, tb) = (
        a["access_token"].as_str().unwrap(),
        b["access_token"].as_str().unwrap(),
    );

    let mut response = open(&server.base, ta, None).await;
    assert_eq!(response.status(), 200);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let mut other = open(&server.base, tb, None).await;
    let (mut buf, mut other_buf) = (String::new(), String::new());

    patch_store(&server.base, ta, "Renamed").await;
    let (id, name, data) = event(&mut response, &mut buf).await;
    assert_eq!(name, "store.changed");
    assert_eq!(data["id"], id);
    assert!(id.starts_with("evt_") && id.len() == 19);
    assert_eq!(data["store_id"], a["store"]["id"]);
    assert_eq!(data["data"]["fields"], json!(["name"]));
    assert!(data["cursor"].is_string(), "carries the change-feed cursor");

    // Store B only ever sees its own event.
    patch_store(&server.base, tb, "Other").await;
    let (_, _, other_data) = event(&mut other, &mut other_buf).await;
    assert_eq!(other_data["store_id"], b["store"]["id"]);
    server.stop().await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn requires_a_valid_bearer_token_and_sends_heartbeats() {
    let (server, _) = start().await;
    let anonymous = taphoa_api::http_client()
        .get(format!("{}/v1/events", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    let bad = open(&server.base, "garbage", None).await;
    assert_eq!(bad.status(), 401);

    let lead = create_store(&server.base).await;
    let mut response = open(&server.base, lead["access_token"].as_str().unwrap(), None).await;
    let mut buf = String::new();
    let f = frame(&mut response, &mut buf).await;
    assert!(
        f.starts_with(": ping") || f.starts_with(':'),
        "heartbeat comment, got {f:?}"
    );
    server.stop().await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn last_event_id_resumes_without_gaps_or_duplicates() {
    let (server, _) = start().await;
    let lead = create_store(&server.base).await;
    let token = lead["access_token"].as_str().unwrap();
    let mut response = open(&server.base, token, None).await;
    let mut buf = String::new();
    patch_store(&server.base, token, "one").await;
    let (first, _, _) = event(&mut response, &mut buf).await;
    drop(response); // client goes away (tunnel, screen off)

    patch_store(&server.base, token, "two").await;
    patch_store(&server.base, token, "three").await;
    let mut resumed = open(&server.base, token, Some(&first)).await;
    let mut buf = String::new();
    let (second, _, d2) = event(&mut resumed, &mut buf).await;
    let (third, _, d3) = event(&mut resumed, &mut buf).await;
    assert!(
        first < second && second < third,
        "ids ordered and strictly after Last-Event-ID"
    );
    assert_eq!(
        (d2["data"]["fields"].clone(), d3["data"]["fields"].clone()),
        (json!(["name"]), json!(["name"]))
    );

    // Live events keep flowing after the replay, still without repeats.
    patch_store(&server.base, token, "four").await;
    let (fourth, _, _) = event(&mut resumed, &mut buf).await;
    assert!(third < fourth);
    server.stop().await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn background_tasks_stop_promptly_on_shutdown_with_open_streams() {
    let (server, _) = start().await;
    let lead = create_store(&server.base).await;
    let _open = open(&server.base, lead["access_token"].as_str().unwrap(), None).await;
    timeout(Duration::from_secs(8), server.stop())
        .await
        .expect("graceful shutdown closes SSE streams");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn replay_pages_through_a_backlog_larger_than_one_page() {
    let (server, state) = start().await;
    let lead = create_store(&server.base).await;
    let token = lead["access_token"].as_str().unwrap();
    let store: Uuid = lead["store"]["id"].as_str().unwrap().parse().unwrap();
    let pool = state.postgres.as_ref().unwrap();
    // 2300 already-published events: more than two replay pages.
    let (first,): (i64,) = sqlx::query_as(
        "WITH ins AS (INSERT INTO outbox_events (store_id,type,payload,published_at) \
         SELECT $1,'store.changed','{}'::jsonb,now() FROM generate_series(1,2300) RETURNING id) \
         SELECT min(id) FROM ins",
    )
    .bind(store)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE outbox_events SET payload=jsonb_build_object('id','evt_'||lpad(id::text,15,'0'),'type',type,'version',1,\
         'store_id',store_id,'occurred_at','2026-10-23T09:14:02.511+07:00','actor',NULL,'data',jsonb_build_object('fields',jsonb_build_array('x'))) \
         WHERE store_id=$1 AND id>=$2",
    )
    .bind(store)
    .bind(first)
    .execute(pool)
    .await
    .unwrap();

    let mut resumed = open(&server.base, token, Some(&format!("evt_{:015}", first - 1))).await;
    let mut buf = String::new();
    let mut previous = first - 1;
    let mut count = 0;
    while count < 2300 {
        let (id, _, _) = event(&mut resumed, &mut buf).await;
        let n: i64 = id.trim_start_matches("evt_").parse().unwrap();
        assert_eq!(n, previous + 1, "no gaps or repeats across page boundaries");
        previous = n;
        count += 1;
    }
    cleanup(pool, store).await;
    server.stop().await;
}

/// The token is verified once at connect, so every stream has a bounded lifetime:
/// clients then reconnect with a fresh token and resume from their last event id.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn stream_ends_at_its_lifetime_cap_and_resumes_by_event_id() {
    assert_eq!(
        taphoa_api::events::MAX_STREAM_AGE,
        Duration::from_secs(15 * 60)
    );
    let cap = Duration::from_millis(1500);
    let (server, _) = start_with(Hub::with_limits(Duration::from_millis(300), cap)).await;
    let lead = create_store(&server.base).await;
    let token = lead["access_token"].as_str().unwrap();
    let opened = std::time::Instant::now();
    let mut stream = open(&server.base, token, None).await;
    let mut buf = String::new();
    patch_store(&server.base, token, "before").await;
    let (seen, _, _) = event(&mut stream, &mut buf).await;

    // Idle apart from heartbeats, the stream must still end cleanly at the cap.
    loop {
        let chunk = timeout(Duration::from_secs(5), stream.chunk())
            .await
            .expect("stream ends at its lifetime cap")
            .expect("server closes the stream cleanly, not with a transport error");
        if chunk.is_none() {
            break;
        }
    }
    let lived = opened.elapsed();
    assert!(lived >= cap, "closed early after {lived:?}");
    assert!(
        lived < cap + Duration::from_secs(3),
        "closed late: {lived:?}"
    );

    // A reconnect resumes from the last received id, without gaps.
    patch_store(&server.base, token, "while-closed").await;
    let mut resumed = open(&server.base, token, Some(&seen)).await;
    let mut buf = String::new();
    let (missed, name, data) = event(&mut resumed, &mut buf).await;
    assert!(seen < missed);
    assert_eq!(name, "store.changed");
    assert_eq!(data["data"]["fields"], json!(["name"]));
    server.stop().await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn stream_ends_after_its_member_is_deactivated() {
    let (server, state) = start().await;
    let lead = create_store(&server.base).await;
    let token = lead["access_token"].as_str().unwrap();
    let mut mine = open(&server.base, token, None).await;
    let mut buf = String::new();

    let store: Uuid = lead["store"]["id"].as_str().unwrap().parse().unwrap();
    let member: Uuid = lead["member"]["id"].as_str().unwrap().parse().unwrap();
    let mut tx = state.postgres.as_ref().unwrap().begin().await.unwrap();
    emit(
        &mut tx,
        Event {
            store_id: store,
            actor: None,
            typ: "member.changed",
            version: 1,
            data: json!({"member_id":Uuid::new_v4(),"change":"deactivated"}),
            change: None,
        },
    )
    .await
    .unwrap();
    emit(
        &mut tx,
        Event {
            store_id: store,
            actor: None,
            typ: "member.changed",
            version: 1,
            data: json!({"member_id":member,"change":"updated"}),
            change: None,
        },
    )
    .await
    .unwrap();
    emit(
        &mut tx,
        Event {
            store_id: store,
            actor: None,
            typ: "member.changed",
            version: 1,
            data: json!({"member_id":member,"change":"deactivated"}),
            change: None,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for change in ["deactivated", "updated", "deactivated"] {
        let (_, name, data) = event(&mut mine, &mut buf).await;
        assert_eq!(name, "member.changed");
        assert_eq!(data["data"]["change"], change);
    }
    // Only heartbeats may still be buffered; the stream must then reach EOF.
    loop {
        let chunk = timeout(Duration::from_secs(5), mine.chunk())
            .await
            .expect("stream ends after the revocation event")
            .unwrap();
        if chunk.is_none() {
            break;
        }
    }
    server.stop().await;
}
