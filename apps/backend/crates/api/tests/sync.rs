//! GET /v1/sync/changes against real Postgres (and Redis, for the shared AppState).
mod common;
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::Contract;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use taphoa_api::{
    AppState,
    config::Config,
    router,
    storage::{ObjectStore, SignedUrl},
};
use tower::ServiceExt;
use uuid::Uuid;

struct FakeStore;
#[async_trait]
impl ObjectStore for FakeStore {
    async fn put(&self, _: &str, _: &str, _: Vec<u8>) -> anyhow::Result<()> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        Ok(SignedUrl {
            url: format!("https://fake.test/{key}?signed=1"),
            expires_at: chrono::Utc::now() + chrono::Duration::from_std(ttl)?,
        })
    }
}

async fn setup() -> (Router, AppState) {
    let config = Config::from_lookup(|key| match key {
        "JWT_SECRET" => Some("sync-test-secret-at-least-32-bytes!!".into()),
        _ => std::env::var(key).ok(),
    })
    .unwrap();
    let mut state = AppState::connect_with_config(&config, None).await.unwrap();
    state.storage = Some(Arc::new(FakeStore));
    (router(state.clone()), state)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 22).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
async fn create_store(app: &Router) -> Value {
    let (status, body) = call(
        app,
        "POST",
        "/v1/stores",
        None,
        json!({"store_name":"Sync","display_name":"Lead","device":{"name":"d","platform":"web"}}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}
async fn join_seller(app: &Router, lead_token: &str) -> Value {
    let (_, invite) = call(app, "POST", "/v1/invites", Some(lead_token), json!({})).await;
    let (status, body) = call(
        app,
        "POST",
        "/v1/auth/join",
        None,
        json!({"invite_token":invite["token"],"display_name":"Seller","device":{"name":"d","platform":"web"}}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}
async fn feed(app: &Router, token: &str, query: &str) -> (StatusCode, Value) {
    call(
        app,
        "GET",
        &format!("/v1/sync/changes{query}"),
        Some(token),
        Value::Null,
    )
    .await
}
async fn ok_feed(app: &Router, token: &str, query: &str) -> Value {
    let (status, body) = feed(app, token, query).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    Contract::load().assert_conforms("/v1/sync/changes", "get", status, &body);
    body
}
fn decode(cursor: &str) -> i64 {
    i64::from_be_bytes(URL_SAFE_NO_PAD.decode(cursor).unwrap().try_into().unwrap())
}
fn encode(seq: i64) -> String {
    URL_SAFE_NO_PAD.encode(seq.to_be_bytes())
}
fn token(session: &Value) -> &str {
    session["access_token"].as_str().unwrap()
}
fn kinds(feed: &Value) -> Vec<(String, String)> {
    feed["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["entity"].as_str().unwrap().into(),
                c["op"].as_str().unwrap().into(),
            )
        })
        .collect()
}
/// Insert a product with one image straight into SQL (catalog endpoints belong to E3).
async fn insert_product(
    state: &AppState,
    store: Uuid,
    member: Uuid,
    price: i64,
    cost: i64,
) -> Uuid {
    let pool = state.postgres.as_ref().unwrap();
    let (product, image) = (Uuid::now_v7(), Uuid::new_v4());
    sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size) VALUES ($1,$2,$3,'image/jpeg',10)")
        .bind(image).bind(store).bind(format!("t/{image}")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO products (id,store_id,name,price,cost_price,request_hash,created_by) VALUES ($1,$2,'Sting',$3,$4,'\\x00',$5)")
        .bind(product).bind(store).bind(price).bind(cost).bind(member).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO product_images (product_id,image_id,position) VALUES ($1,$2,0)")
        .bind(product)
        .bind(image)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO change_log (store_id,entity,entity_id,op) VALUES ($1,'product',$2,'upsert')",
    )
    .bind(store)
    .bind(product)
    .execute(pool)
    .await
    .unwrap();
    product
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn snapshot_then_incremental_pull_with_stable_cursor() {
    let (app, _) = setup().await;
    let lead = create_store(&app).await;
    let t = token(&lead);
    let snapshot = ok_feed(&app, t, "").await;
    let mut seen = kinds(&snapshot);
    seen.sort();
    assert_eq!(
        seen,
        vec![
            ("member".to_string(), "upsert".to_string()),
            ("store".to_string(), "upsert".to_string())
        ]
    );
    assert_eq!(snapshot["has_more"], false);
    let seqs: Vec<i64> = snapshot["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["seq"].as_i64().unwrap())
        .collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "ordered by seq");
    let cursor = snapshot["cursor"].as_str().unwrap().to_string();
    assert_eq!(
        decode(&cursor),
        *seqs.last().unwrap(),
        "cursor = base64url(be i64 seq)"
    );

    let again = ok_feed(&app, t, &format!("?since={cursor}")).await;
    assert!(again["changes"].as_array().unwrap().is_empty());
    assert_eq!(again["cursor"], cursor, "empty pull keeps the cursor");

    let (status, _) = call(
        &app,
        "PATCH",
        "/v1/store",
        Some(t),
        json!({"name":"Renamed"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let delta = ok_feed(&app, t, &format!("?since={cursor}")).await;
    assert_eq!(
        kinds(&delta),
        vec![("store".to_string(), "upsert".to_string())]
    );
    assert_eq!(delta["changes"][0]["data"]["name"], "Renamed");
    assert_eq!(delta["changes"][0]["id"], lead["store"]["id"]);
    assert!(decode(delta["cursor"].as_str().unwrap()) > decode(&cursor));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn repeated_edits_collapse_and_pages_follow_limit() {
    let (app, _) = setup().await;
    let lead = create_store(&app).await;
    let t = token(&lead);
    let start = ok_feed(&app, t, "").await["cursor"]
        .as_str()
        .unwrap()
        .to_string();
    for name in ["A", "B", "C"] {
        call(&app, "PATCH", "/v1/store", Some(t), json!({"name":name})).await;
    }
    let delta = ok_feed(&app, t, &format!("?since={start}")).await;
    assert_eq!(
        delta["changes"].as_array().unwrap().len(),
        1,
        "latest change per entity only"
    );
    assert_eq!(delta["changes"][0]["data"]["name"], "C");

    // Page through the full snapshot one change at a time.
    let mut cursor = String::new();
    let mut total = 0;
    loop {
        let query = if cursor.is_empty() {
            "?limit=1".to_string()
        } else {
            format!("?limit=1&since={cursor}")
        };
        let page = ok_feed(&app, t, &query).await;
        total += page["changes"].as_array().unwrap().len();
        cursor = page["cursor"].as_str().unwrap().to_string();
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
        assert_eq!(page["changes"].as_array().unwrap().len(), 1);
    }
    assert_eq!(total, 2, "store + lead member");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn rejects_bad_input_and_isolates_stores() {
    let (app, _) = setup().await;
    let (status, body) = call(&app, "GET", "/v1/sync/changes", None, Value::Null).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("unauthorized"))
    );
    let a = create_store(&app).await;
    let b = create_store(&app).await;
    for query in [
        "?since=not-base64!!",
        "?since=AAAA",
        "?limit=0",
        "?limit=1001",
        "?limit=x",
    ] {
        let (status, body) = feed(&app, token(&a), query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["code"], "validation_failed");
    }
    let only_a = ok_feed(&app, token(&a), "").await;
    let ids: Vec<&str> = only_a["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&b["store"]["id"].as_str().unwrap()));
    assert!(!ids.contains(&b["member"]["id"].as_str().unwrap()));
    // A cursor is just a number scoped by store_id, so one from elsewhere is harmless.
    let cross = ok_feed(&app, token(&b), &format!("?since={}", encode(0))).await;
    assert_eq!(cross["changes"].as_array().unwrap().len(), 2);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn deletes_and_vanished_rows_arrive_as_delete_ops() {
    let (app, state) = setup().await;
    let lead = create_store(&app).await;
    let t = token(&lead);
    let store: Uuid = lead["store"]["id"].as_str().unwrap().parse().unwrap();
    let start = ok_feed(&app, t, "").await["cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let pool = state.postgres.as_ref().unwrap();
    let (explicit, vanished) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO change_log (store_id,entity,entity_id,op) VALUES ($1,'category',$2,'delete'), ($1,'category',$3,'upsert')")
        .bind(store).bind(explicit).bind(vanished).execute(pool).await.unwrap();
    let delta = ok_feed(&app, t, &format!("?since={start}")).await;
    let changes = delta["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    for change in changes {
        assert_eq!(
            (change["entity"].as_str(), change["op"].as_str()),
            (Some("category"), Some("delete"))
        );
        assert!(change.get("data").is_none() || change["data"].is_null());
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn cost_price_is_lead_only_and_products_carry_images() {
    let (app, state) = setup().await;
    let lead = create_store(&app).await;
    let seller = join_seller(&app, token(&lead)).await;
    let store: Uuid = lead["store"]["id"].as_str().unwrap().parse().unwrap();
    let member: Uuid = lead["member"]["id"].as_str().unwrap().parse().unwrap();
    let product = insert_product(&state, store, member, 11_000, 8_500).await;
    let find = |feed: &Value| {
        feed["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == product.to_string())
            .cloned()
            .unwrap()
    };
    let lead_view = find(&ok_feed(&app, token(&lead), "").await);
    assert_eq!(lead_view["entity"], "product");
    assert_eq!(lead_view["data"]["cost_price"], 8_500);
    assert_eq!(lead_view["data"]["price"], 11_000);
    assert_eq!(lead_view["data"]["images"].as_array().unwrap().len(), 1);
    assert!(
        lead_view["data"]["images"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://")
    );
    let seller_view = find(&ok_feed(&app, token(&seller), "").await);
    assert!(
        seller_view["data"]
            .get("cost_price")
            .is_none_or(Value::is_null),
        "sellers never see cost"
    );
    assert_eq!(seller_view["data"]["price"], 11_000);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn cursor_below_compaction_floor_returns_410() {
    let (app, state) = setup().await;
    let lead = create_store(&app).await;
    let t = token(&lead);
    let store: Uuid = lead["store"]["id"].as_str().unwrap().parse().unwrap();
    let snapshot = ok_feed(&app, t, "").await;
    let high = decode(snapshot["cursor"].as_str().unwrap());
    sqlx::query("INSERT INTO change_log_floor (store_id,floor_seq) VALUES ($1,$2)")
        .bind(store)
        .bind(high)
        .execute(state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    let (status, body) = feed(&app, t, &format!("?since={}", encode(high - 1))).await;
    assert_eq!(status, StatusCode::GONE, "{body}");
    Contract::load().assert_conforms("/v1/sync/changes", "get", status, &body);
    // At or above the floor, and a fresh snapshot, still work.
    ok_feed(&app, t, &format!("?since={}", encode(high))).await;
    ok_feed(&app, t, "").await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn feed_query_uses_the_store_seq_index() {
    let (_, state) = setup().await;
    let pool = state.postgres.as_ref().unwrap();
    // Force the planner to price the index path even on an empty table.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let plan: Vec<String> = sqlx::query_scalar(&format!(
        "EXPLAIN SELECT seq FROM change_log WHERE store_id='{}' AND seq>0 ORDER BY seq LIMIT 501",
        Uuid::new_v4()
    ))
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    assert!(
        plan.join("\n").contains("change_log_store_seq"),
        "{plan:#?}"
    );
}
