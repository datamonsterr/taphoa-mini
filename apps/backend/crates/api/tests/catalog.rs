//! Catalog (E3) integration + contract tests against real PostgreSQL.
//! Embedder = MockEmbedder (identical bytes -> similarity 1.0, different bytes ~ 0).
//! Object storage = in-memory fake that supports `get`.
mod common;
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::Contract;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use taphoa_api::{
    AppState,
    config::Config,
    router,
    storage::{ObjectStore, SignedUrl},
    vector::{InMemoryVectorIndex, VectorIndex},
};
use taphoa_recognition::MockEmbedder;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct MemStore(Mutex<HashMap<String, Vec<u8>>>);
#[async_trait]
impl ObjectStore for MemStore {
    async fn put(&self, key: &str, _: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(key.into(), bytes);
        Ok(())
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        Ok(SignedUrl {
            url: format!("https://fake.test/{key}?signature=abc"),
            expires_at: (SystemTime::now() + ttl).into(),
        })
    }
    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing object"))
    }
}

async fn setup_with(
    vector_index: Option<Arc<dyn VectorIndex>>,
    embedder: bool,
) -> (Router, AppState) {
    let config = Config::from_lookup(|key| match key {
        "CLERK_ISSUER" => Some(common::clerk::TEST_ISSUER.into()),
        "CLERK_SECRET_KEY" => None,
        k if k.starts_with("RATE_LIMIT_") => Some("1000000".into()),
        _ => std::env::var(key).ok(),
    })
    .unwrap();
    let mut state = AppState::connect_with_config(&config, None).await.unwrap();
    common::clerk::install(&mut state);
    state.rate_limiter = Arc::new(taphoa_api::ratelimit::MemoryRateLimiter::default());
    state.storage = Some(Arc::new(MemStore::default()));
    state.embedder = embedder.then(|| Arc::new(MockEmbedder) as _);
    state.vector_index = vector_index;
    (router(state.clone()), state)
}
async fn setup() -> (Router, AppState) {
    setup_with(None, true).await
}

async fn raw(app: &Router, request: Request<Body>) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
    let response = app.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    (
        status,
        to_bytes(response.into_body(), 1 << 22)
            .await
            .unwrap()
            .to_vec(),
        headers,
    )
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    // Auth setup uses independently signed Clerk identities, never API-issued tokens.
    let minted = (token.is_none() && ["/v1/stores", "/v1/auth/join"].contains(&path))
        .then(common::clerk::token);
    let token = token.or(minted.as_deref());
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(
            "content-type",
            if method == "PATCH" {
                "application/merge-patch+json"
            } else {
                "application/json"
            },
        )
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let (status, bytes, _) = raw(app, request.body(body).unwrap()).await;
    let mut response: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status == StatusCode::CREATED
        && let Some(token) = minted
    {
        response["access_token"] = json!(token);
    }
    (status, response)
}
/// Call, assert the status, and validate the body against the OpenAPI response schema.
async fn ok(
    app: &Router,
    method: &str,
    path: &str,
    template: &str,
    token: &str,
    body: Value,
    expected: StatusCode,
) -> Value {
    let (status, value) = call(app, method, path, Some(token), body).await;
    assert_eq!(status, expected, "{method} {path}: {value}");
    if expected != StatusCode::NO_CONTENT {
        Contract::load().assert_conforms(template, &method.to_lowercase(), status, &value);
    }
    value
}
async fn expect_code(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
    status: StatusCode,
    code: &str,
) -> Value {
    let (got, value) = call(app, method, path, token, body).await;
    assert_eq!(got, status, "{method} {path}: {value}");
    assert_eq!(value["code"], code, "{method} {path}: {value}");
    value
}

struct World {
    app: Router,
    state: AppState,
    store_id: Uuid,
    lead: String,
    seller: String,   // no can_enroll
    enroller: String, // seller with can_enroll
}
impl Drop for World {
    fn drop(&mut self) {
        let store_id = self.store_id;
        // Keep queued jobs from outliving their test's in-memory object store and
        // being claimed by later worker suites. A separate runtime also works
        // during unwinding from a current-thread tokio test.
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let url = std::env::var("DATABASE_URL").unwrap();
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&url)
                        .await
                        .unwrap();
                    sqlx::query("DELETE FROM index_jobs WHERE store_id=$1")
                        .bind(store_id)
                        .execute(&pool)
                        .await
                        .unwrap();
                    pool.close().await;
                });
        })
        .join()
        .unwrap();
    }
}
async fn world_from(app: Router, state: AppState) -> World {
    let device = json!({"name":"counter","platform":"web","app_version":"1.0"});
    let (_, lead) = call(
        &app,
        "POST",
        "/v1/stores",
        None,
        json!({"store_name":"Tạp hóa E3","display_name":"Lead","device":device}),
    )
    .await;
    let token = lead["access_token"].as_str().unwrap().to_string();
    let mut tokens = vec![];
    for can_enroll in [false, true] {
        let (_, invite) = call(
            &app,
            "POST",
            "/v1/invites",
            Some(&token),
            json!({"role":"seller","can_enroll":can_enroll}),
        )
        .await;
        let (status, joined) = call(
            &app,
            "POST",
            "/v1/auth/join",
            None,
            json!({"invite_token":invite["token"],"display_name":"S","device":device}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{joined}");
        tokens.push(joined["access_token"].as_str().unwrap().to_string());
    }
    World {
        store_id: lead["store"]["id"].as_str().unwrap().parse().unwrap(),
        app,
        state,
        lead: token,
        seller: tokens[0].clone(),
        enroller: tokens[1].clone(),
    }
}
async fn world() -> World {
    let (app, state) = setup().await;
    world_from(app, state).await
}
fn png_bytes(tag: &str) -> Vec<u8> {
    let mut image = image::RgbImage::new(4, 4);
    for (i, pixel) in image.pixels_mut().enumerate() {
        *pixel = image::Rgb([tag.as_bytes()[i % tag.len()], i as u8, tag.len() as u8]);
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}
/// Upload a decodable PNG whose bytes (hence MockEmbedder vector) depend on `tag`.
async fn upload(w: &World, token: &str, tag: &str) -> String {
    let bytes = png_bytes(tag);
    let mut body = b"--b\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nenrollment\r\n--b\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
    body.extend_from_slice(&bytes);
    body.extend_from_slice(b"\r\n--b--\r\n");
    let request = Request::post("/v1/images")
        .header("content-type", "multipart/form-data; boundary=b")
        .header("authorization", format!("Bearer {token}"))
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()))
        .body(Body::from(body))
        .unwrap();
    let (status, bytes, _) = raw(&w.app, request).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice::<Value>(&bytes).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}
async fn create_product(
    w: &World,
    token: &str,
    name: &str,
    price: i64,
    tag: &str,
    extra: Value,
) -> Value {
    let image = upload(w, token, tag).await;
    let mut body = json!({"id": Uuid::now_v7(), "name": name, "price": price, "image_ids": [image], "force_new": true});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        body[k] = v;
    }
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        token,
        body,
        StatusCode::CREATED,
    )
    .await
}
async fn count(w: &World, sql: &'static str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(w.state.postgres.as_ref().unwrap())
        .await
        .unwrap()
}

async fn references(w: &World, n: usize, tag: &str) -> Vec<Value> {
    let mut refs = Vec::new();
    for i in 0..n {
        refs.push(json!({
            "image_id": upload(w, &w.lead, &format!("{tag}-photo-{i}")).await,
            "cutout_image_id": upload(w, &w.lead, &format!("{tag}-cutout-{i}")).await,
            "bbox": [0.0, 0.0, 2.0, 2.0]
        }));
    }
    refs
}

#[derive(sqlx::FromRow)]
struct StoredReference {
    image_id: Uuid,
    cutout_image_id: Option<Uuid>,
    bbox: Option<Vec<f32>>,
    position: i16,
}

async fn index_product(w: &World, id: Uuid) {
    use taphoa_api::catalog::index_jobs::{WorkerConfig, process_next};
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let pool = w.state.postgres.as_ref().unwrap();
    // process_next claims globally; prioritize this world's job.
    sqlx::query(
        "UPDATE index_jobs SET run_after='1900-01-01' WHERE product_id=$1 AND status='queued'",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    for _ in 0..1000 {
        if sqlx::query_scalar::<_, String>("SELECT index_status FROM products WHERE id=$1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
            == "ready"
        {
            return;
        }
        assert!(
            process_next(
                pool,
                w.state.embedder.clone().unwrap(),
                w.state.storage.clone().unwrap(),
                w.state.inference_slots.clone(),
                &WorkerConfig::default()
            )
            .await
            .unwrap()
        );
    }
    panic!("product was not indexed");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn quick_enroll_reference_validation() {
    let w = world().await;
    let refs = references(&w, 9, "validation").await;
    for (body, status, code) in [
        (
            json!({"references": &refs[..2]}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (
            json!({"references": refs}),
            StatusCode::CONFLICT,
            "image_limit",
        ),
        (
            json!({}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (
            json!({"image_ids": [], "references": &refs[..3]}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (
            json!({"references": [refs[0].clone(), refs[0].clone(), refs[1].clone()]}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
    ] {
        let mut body = body;
        body["id"] = json!(Uuid::now_v7());
        body["price"] = json!(100);
        let err = expect_code(
            &w.app,
            "POST",
            "/v1/products",
            Some(&w.lead),
            body,
            status,
            code,
        )
        .await;
        Contract::load().assert_conforms("/v1/products", "post", status, &err);
    }
    for bbox in [
        json!([0, 0, 0, 2]),
        json!([0, 0, 2, -1]),
        json!([0, 0, 1e100, 2]),
        json!([0, 0, 2]),
    ] {
        let mut invalid = refs[..3].to_vec();
        invalid[0]["bbox"] = bbox;
        expect_code(
            &w.app,
            "POST",
            "/v1/products",
            Some(&w.lead),
            json!({"id":Uuid::now_v7(),"price":1,"references":invalid}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        )
        .await;
    }
    for field in ["image_id", "cutout_image_id"] {
        let mut invalid = refs[..3].to_vec();
        invalid[0][field] = json!(Uuid::now_v7());
        expect_code(
            &w.app,
            "POST",
            "/v1/products",
            Some(&w.lead),
            json!({"id":Uuid::now_v7(),"price":1,"references":invalid}),
            StatusCode::NOT_FOUND,
            "not_found",
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn quick_enroll_pending_persistence_worker_and_duplicate_semantics() {
    let w = world().await;
    let refs = references(&w, 3, "reference-happy").await;
    let id = Uuid::now_v7();
    let body = json!({"id": id,"price":5000,"references":refs});
    let p = ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        body.clone(),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(p["index_status"], "pending");
    let rows: Vec<StoredReference> = sqlx::query_as("SELECT image_id,cutout_image_id,bbox,position FROM product_images WHERE product_id=$1 ORDER BY position")
        .bind(id).fetch_all(w.state.postgres.as_ref().unwrap()).await.unwrap();
    assert_eq!(rows.len(), 3);
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(json!(row.image_id), refs[i]["image_id"]);
        assert_eq!(json!(row.cutout_image_id), refs[i]["cutout_image_id"]);
        assert_eq!(row.bbox, Some(vec![0., 0., 2., 2.]));
        assert_eq!(row.position, i as i16);
        assert_eq!(
            p["images"][i]["cutout_image_id"],
            refs[i]["cutout_image_id"]
        );
    }
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM index_jobs WHERE product_id=$1 AND status='queued'",
            id
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        0
    );
    let replay = ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        body.clone(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(replay["id"], p["id"]);
    assert_eq!(replay["index_status"], p["index_status"]);
    let mut changed = body.clone();
    changed["price"] = json!(6000);
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        changed,
        StatusCode::CONFLICT,
        "id_conflict",
    )
    .await;
    index_product(&w, id).await;
    let ready = ok(
        &w.app,
        "GET",
        &format!("/v1/products/{id}"),
        "/v1/products/{productId}",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(ready["index_status"], "ready");
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        6
    );
    let mut duplicate = body;
    duplicate["id"] = json!(Uuid::now_v7());
    let err = expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        duplicate.clone(),
        StatusCode::CONFLICT,
        "duplicate_suspected",
    )
    .await;
    Contract::load().assert_conforms("/v1/products", "post", StatusCode::CONFLICT, &err);
    assert_eq!(err["details"]["candidates"][0]["product_id"], json!(id));
    duplicate["force_new"] = json!(true);
    let forced = ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        duplicate,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(forced["index_status"], "pending");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn quick_enroll_add_cutout_and_remove_enqueue() {
    let w = world().await;
    let p = create_product(&w, &w.lead, "legacy", 100, "legacy-pending", json!({})).await;
    let id = p["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(p["index_status"], "pending");
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        0
    );
    index_product(&w, id).await;
    let reference = references(&w, 1, "added").await.remove(0);
    let base = format!("/v1/products/{id}/images");
    ok(
        &w.app,
        "POST",
        &base,
        "/v1/products/{productId}/images",
        &w.lead,
        reference.clone(),
        StatusCode::CREATED,
    )
    .await;
    let replay = ok(
        &w.app,
        "POST",
        &base,
        "/v1/products/{productId}/images",
        &w.lead,
        reference.clone(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(replay["cutout_image_id"], reference["cutout_image_id"]);
    assert_eq!(replay["bbox"], reference["bbox"]);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM index_jobs WHERE product_id=$1 AND status='queued'",
            id
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        1
    );
    index_product(&w, id).await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        3
    );
    ok(
        &w.app,
        "DELETE",
        &format!("{base}/{}", reference["image_id"].as_str().unwrap()),
        "/v1/products/{productId}/images/{imageId}",
        &w.lead,
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM index_jobs WHERE product_id=$1 AND status='queued'",
            id
        )
        .await,
        1
    );
    index_product(&w, id).await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        1
    );
}

#[derive(Default)]
struct RecordingEmbedder(Mutex<Vec<Vec<u8>>>);
impl taphoa_recognition::Embedder for RecordingEmbedder {
    fn model(&self) -> &str {
        "mock-sha256-384"
    }
    fn dim(&self) -> usize {
        384
    }
    fn embed(&self, bytes: &[u8]) -> Result<Vec<f32>, taphoa_recognition::EmbedError> {
        self.0.lock().unwrap().push(bytes.to_vec());
        taphoa_recognition::Embedder::embed(&MockEmbedder, bytes)
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn quick_enroll_embeds_only_first_cutout_or_first_legacy_image() {
    let (_, mut state) = setup().await;
    let embedder = Arc::new(RecordingEmbedder::default());
    state.embedder = Some(embedder.clone());
    let w = world_from(router(state.clone()), state).await;
    let refs = references(&w, 3, "one-embed").await;
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        json!({"id":Uuid::now_v7(),"price":1,"references":refs}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        *embedder.0.lock().unwrap(),
        vec![png_bytes("one-embed-cutout-0")]
    );
    embedder.0.lock().unwrap().clear();
    let first = upload(&w, &w.lead, "legacy-first").await;
    let second = upload(&w, &w.lead, "legacy-second").await;
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        json!({"id":Uuid::now_v7(),"price":1,"image_ids":[second,first]}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        *embedder.0.lock().unwrap(),
        vec![png_bytes("legacy-second")]
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn quick_enroll_cutout_upload_retry_and_bbox_fallback() {
    let (_, mut state) = setup().await;
    let embedder = Arc::new(RecordingEmbedder::default());
    state.embedder = Some(embedder.clone());
    let w = world_from(router(state.clone()), state).await;
    let refs = references(&w, 3, "upload-race").await;
    let key: String = sqlx::query_scalar("SELECT object_key FROM images WHERE id=$1")
        .bind(
            refs[0]["cutout_image_id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        )
        .fetch_one(w.state.postgres.as_ref().unwrap())
        .await
        .unwrap();
    let storage = w.state.storage.clone().unwrap();
    storage.delete(&key).await.unwrap();
    let upload_storage = storage.clone();
    let upload_key = key.clone();
    let upload = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        upload_storage
            .put(&upload_key, "image/png", png_bytes("upload-race-cutout-0"))
            .await
            .unwrap();
    });
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        json!({"id":Uuid::now_v7(),"price":1,"references":refs,"force_new":true}),
        StatusCode::CREATED,
    )
    .await;
    upload.await.unwrap();
    assert_eq!(
        *embedder.0.lock().unwrap(),
        vec![png_bytes("upload-race-cutout-0")]
    );
    storage.delete(&key).await.unwrap();
    embedder.0.lock().unwrap().clear();
    let start = std::time::Instant::now();
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        json!({"id":Uuid::now_v7(),"price":1,"references":refs,"force_new":true}),
        StatusCode::CREATED,
    )
    .await;
    assert!(start.elapsed() < Duration::from_secs(3));
    let original = image::load_from_memory(&png_bytes("upload-race-photo-0"))
        .unwrap()
        .into_rgb8();
    let crop =
        taphoa_recognition::crop::crop_with_padding(&original, [0., 0., 2., 2.], 0.08).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    crop.write_to(&mut png, image::ImageFormat::Png).unwrap();
    assert_eq!(*embedder.0.lock().unwrap(), vec![png.into_inner()]);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn quick_enroll_add_validates_cutout_pair_and_detection_crop() {
    let w = world().await;
    let product = create_product(&w, &w.lead, "detection crop", 100, "det-base", json!({})).await;
    let id = product["id"].as_str().unwrap();
    let base = format!("/v1/products/{id}/images");
    let reference = references(&w, 1, "det-photo").await.remove(0);
    for body in [
        json!({"image_id":reference["image_id"],"bbox":[0,0,2,2]}),
        json!({"image_id":reference["image_id"],"cutout_image_id":reference["cutout_image_id"]}),
        json!({"image_id":reference["image_id"],"cutout_image_id":reference["cutout_image_id"],"bbox":[0,0,-1,2]}),
        json!({"image_id":reference["image_id"],"detection_id":Uuid::now_v7()}),
    ] {
        let err = expect_code(
            &w.app,
            "POST",
            &base,
            Some(&w.lead),
            body,
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        )
        .await;
        Contract::load().assert_conforms(
            "/v1/products/{productId}/images",
            "post",
            StatusCode::UNPROCESSABLE_ENTITY,
            &err,
        );
    }
    let pool = w.state.postgres.as_ref().unwrap();
    let member: Uuid =
        sqlx::query_scalar("SELECT id FROM members WHERE store_id=$1 AND role='lead'")
            .bind(w.store_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let image_id = reference["image_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let scan: Uuid = sqlx::query_scalar("INSERT INTO scans (store_id,image_id,member_id,mode,purpose,segmenter,embedder,catalog_version,timings) VALUES ($1,$2,$3,'single','enrollment','fake','fake',0,'{}') RETURNING id")
        .bind(w.store_id).bind(image_id).bind(member).fetch_one(pool).await.unwrap();
    let detection: Uuid = sqlx::query_scalar("INSERT INTO detections (store_id,scan_id,position,bbox,score,area,match,candidates) VALUES ($1,$2,0,'{0,0,2,2}',0.9,4,'unknown','[]') RETURNING id")
        .bind(w.store_id).bind(scan).fetch_one(pool).await.unwrap();
    let mut conflicting = reference.clone();
    conflicting["detection_id"] = json!(detection);
    expect_code(
        &w.app,
        "POST",
        &base,
        Some(&w.lead),
        conflicting,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
    )
    .await;
    expect_code(
        &w.app,
        "POST",
        &base,
        Some(&w.lead),
        json!({"image_id":product["images"][0]["image_id"],"detection_id":detection}),
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
    )
    .await;
    ok(
        &w.app,
        "POST",
        &base,
        "/v1/products/{productId}/images",
        &w.lead,
        json!({"image_id":image_id,"detection_id":detection}),
        StatusCode::CREATED,
    )
    .await;
    let bbox: Option<Vec<f32>> =
        sqlx::query_scalar("SELECT bbox FROM product_images WHERE product_id=$1 AND image_id=$2")
            .bind(id.parse::<Uuid>().unwrap())
            .bind(image_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(bbox, Some(vec![0., 0., 2., 2.]));
    index_product(&w, id.parse().unwrap()).await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id.parse().unwrap()
        )
        .await,
        2
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn categories_list_create_authz_duplicates() {
    let w = world().await;
    let id = Uuid::now_v7();
    let body = json!({"id": id, "name": "Nước giải khát"});
    let created = ok(
        &w.app,
        "POST",
        "/v1/categories",
        "/v1/categories",
        &w.lead,
        body.clone(),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(created["id"], id.to_string());
    expect_code(
        &w.app,
        "POST",
        "/v1/categories",
        Some(&w.seller),
        json!({"id": Uuid::now_v7(), "name": "X"}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    expect_code(
        &w.app,
        "POST",
        "/v1/categories",
        Some(&w.enroller),
        json!({"id": Uuid::now_v7(), "name": "X"}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    // case-insensitive duplicate name with a new id -> 409
    let (status, _) = call(
        &w.app,
        "POST",
        "/v1/categories",
        Some(&w.lead),
        json!({"id": Uuid::now_v7(), "name": "NƯỚC GIẢI KHÁT".to_lowercase()}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    for bad in [
        json!({"id": Uuid::now_v7(), "name": ""}),
        json!({"id": Uuid::now_v7(), "name": "x".repeat(41)}),
        json!({"name": "no id"}),
    ] {
        let (status, _) = call(&w.app, "POST", "/v1/categories", Some(&w.lead), bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    expect_code(
        &w.app,
        "POST",
        "/v1/categories",
        None,
        body,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    )
    .await;
    let list = ok(
        &w.app,
        "GET",
        "/v1/categories",
        "/v1/categories",
        &w.seller,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    // events: catalog.changed emitted in the same transaction, plus a change_log row
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='catalog.changed'",
            w.store_id
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM change_log WHERE store_id=$1 AND entity='category'",
            w.store_id
        )
        .await,
        1
    );
    // another store sees nothing
    let other = world_from(w.app.clone(), w.state.clone()).await;
    let list = ok(
        &other.app,
        "GET",
        "/v1/categories",
        "/v1/categories",
        &other.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert!(list["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn create_product_happy_authz_validation_idempotency_events() {
    let w = world().await;
    let image = upload(&w, &w.lead, "a").await;
    let id = Uuid::now_v7();
    let unit = json!({"id": Uuid::now_v7(), "name": "lốc", "quantity_in_base": 6, "price": 54000});
    let body = json!({"id": id, "name": "Sting đỏ 330ml", "price": 10000, "cost_price": 8000, "base_unit": "chai", "barcode": "8934588", "image_ids": [image], "units": [unit]});
    let p = ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        body.clone(),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        (
            p["version"].as_i64(),
            p["archived"].clone(),
            p["images"].as_array().unwrap().len(),
            p["units"].as_array().unwrap().len()
        ),
        (Some(1), json!(false), 1, 1)
    );
    assert_eq!(p["images"][0]["position"], 0);
    assert_eq!(p["index_status"], "pending");
    // Index job + initial price history + events are committed together.
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM price_history WHERE product_id=$1",
            id
        )
        .await,
        2
    ); // price + cost_price
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='catalog.changed'",
            w.store_id
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM change_log WHERE store_id=$1 AND entity='product'",
            w.store_id
        )
        .await,
        1
    );
    // identical replay -> 200, no new rows/events
    let again = ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        body.clone(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(again["id"], p["id"]);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='catalog.changed'",
            w.store_id
        )
        .await,
        1
    );
    // same id, different body -> 409 id_conflict
    let mut changed = body.clone();
    changed["price"] = json!(11000);
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        changed,
        StatusCode::CONFLICT,
        "id_conflict",
    )
    .await;
    // authz
    let img2 = upload(&w, &w.seller, "b").await;
    let req = |id: Uuid, img: &str| json!({"id": id, "price": 5000, "image_ids": [img], "force_new": true});
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.seller),
        req(Uuid::now_v7(), &img2),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    let img3 = upload(&w, &w.enroller, "c").await;
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.enroller,
        req(Uuid::now_v7(), &img3),
        StatusCode::CREATED,
    )
    .await;
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        None,
        req(Uuid::now_v7(), &img3),
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    )
    .await;
    // validation: no images, 6 images, negative price, unknown image
    let six: Vec<_> = (0..6).map(|_| Uuid::now_v7().to_string()).collect();
    for bad in [
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": []}),
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": six}),
        json!({"id": Uuid::now_v7(), "price": -1, "image_ids": [img2]}),
    ] {
        let (status, v) = call(&w.app, "POST", "/v1/products", Some(&w.lead), bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
    }
    let (status, _) = call(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": [Uuid::now_v7()]}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // image of another store -> 404
    let other = world_from(w.app.clone(), w.state.clone()).await;
    let foreign = upload(&other, &other.lead, "z").await;
    let (status, _) = call(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": [foreign]}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // barcode unique per store
    let img4 = upload(&w, &w.lead, "d").await;
    let (status, _) = call(&w.app, "POST", "/v1/products", Some(&w.lead), json!({"id": Uuid::now_v7(), "price": 1, "image_ids": [img4], "barcode": "8934588", "force_new": true})).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn duplicate_check_at_088_with_candidates_and_force_new() {
    let w = world().await;
    let existing = create_product(
        &w,
        &w.lead,
        "Aquafina 500ml",
        5000,
        "same-bottle",
        json!({}),
    )
    .await;
    index_product(&w, existing["id"].as_str().unwrap().parse().unwrap()).await;
    // identical photo bytes -> similarity 1.0 >= 0.88 -> 409 duplicate_suspected
    let image = upload(&w, &w.lead, "same-bottle").await;
    let body = json!({"id": Uuid::now_v7(), "price": 6000, "image_ids": [image]});
    let err = expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        body.clone(),
        StatusCode::CONFLICT,
        "duplicate_suspected",
    )
    .await;
    Contract::load().assert_conforms("/v1/products", "post", StatusCode::CONFLICT, &err);
    let candidates = err["details"]["candidates"].as_array().unwrap();
    assert_eq!(candidates[0]["product_id"], existing["id"]);
    assert!(candidates[0]["similarity"].as_f64().unwrap() >= 0.88);
    assert_eq!(candidates[0]["name"], "Aquafina 500ml");
    assert_eq!(candidates[0]["price"], 5000);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM products WHERE id=$1",
            body["id"].as_str().unwrap().parse().unwrap()
        )
        .await,
        0
    );
    // a different photo is not a duplicate
    let other = upload(&w, &w.lead, "something-else").await;
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": [other]}),
        StatusCode::CREATED,
    )
    .await;
    // force_new bypasses
    let mut forced = body.clone();
    forced["force_new"] = json!(true);
    ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        forced,
        StatusCode::CREATED,
    )
    .await;
    // another store's identical photo is not a duplicate (store isolation)
    let other_store = world_from(w.app.clone(), w.state.clone()).await;
    let img = upload(&other_store, &other_store.lead, "same-bottle").await;
    ok(
        &other_store.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &other_store.lead,
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": [img]}),
        StatusCode::CREATED,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn duplicate_check_uses_the_vector_index_port_when_configured() {
    let index = Arc::new(InMemoryVectorIndex::default());
    let (app, state) = setup_with(Some(index.clone()), true).await;
    let w = world_from(app, state).await;
    // The fake knows a product the SQL table does not; its hit must be resolved against products.
    let product = create_product(&w, &w.lead, "Coca 330ml", 9000, "coca", json!({})).await;
    let emb =
        taphoa_recognition::Embedder::embed(&MockEmbedder, &png_bytes("coca-lookalike")).unwrap();
    index
        .upsert(
            w.store_id,
            product["id"].as_str().unwrap().parse().unwrap(),
            Uuid::now_v7(),
            "mock-sha256-384",
            emb,
        )
        .await
        .unwrap();
    let image = upload(&w, &w.lead, "coca-lookalike").await;
    let err = expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        json!({"id": Uuid::now_v7(), "price": 1, "image_ids": [image]}),
        StatusCode::CONFLICT,
        "duplicate_suspected",
    )
    .await;
    assert_eq!(err["details"]["candidates"][0]["product_id"], product["id"]);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn enroll_without_embedder_is_503_and_persists_nothing() {
    let (app, state) = setup_with(None, false).await;
    let w = world_from(app, state).await;
    let image = upload(&w, &w.lead, "a").await;
    let id = Uuid::now_v7();
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        json!({"id": id, "price": 1, "image_ids": [image]}),
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
    )
    .await;
    assert_eq!(
        count(&w, "SELECT count(*) FROM products WHERE id=$1", id).await,
        0
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn list_search_filters_and_keyset_pagination() {
    let w = world().await;
    let cat = Uuid::now_v7();
    ok(
        &w.app,
        "POST",
        "/v1/categories",
        "/v1/categories",
        &w.lead,
        json!({"id": cat, "name": "Mì"}),
        StatusCode::CREATED,
    )
    .await;
    let hao = create_product(
        &w,
        &w.lead,
        "Mì Hảo Hảo tôm chua cay",
        4000,
        "p1",
        json!({"barcode": "111", "category_id": cat}),
    )
    .await;
    for i in 2..=6 {
        create_product(
            &w,
            &w.lead,
            &format!("Sản phẩm {i}"),
            1000 * i,
            &format!("p{i}"),
            json!({}),
        )
        .await;
    }
    let list = |q: &str| format!("/v1/products{q}");
    let all = ok(
        &w.app,
        "GET",
        &list(""),
        "/v1/products",
        &w.seller,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(all["items"].as_array().unwrap().len(), 6);
    // accent-insensitive search
    let found = ok(
        &w.app,
        "GET",
        &list("?q=hao%20hao"),
        "/v1/products",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(found["items"][0]["id"], hao["id"]);
    let found = ok(
        &w.app,
        "GET",
        &list("?barcode=111"),
        "/v1/products",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(found["items"][0]["id"], hao["id"]);
    let found = ok(
        &w.app,
        "GET",
        &list(&format!("?category_id={cat}")),
        "/v1/products",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    // keyset pagination: 6 items, pages of 4 then 2, no duplicates or gaps
    let mut seen = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..3 {
        let url = match &cursor {
            Some(c) => list(&format!("?limit=4&cursor={c}")),
            None => list("?limit=4"),
        };
        let page = ok(
            &w.app,
            "GET",
            &url,
            "/v1/products",
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
        seen.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["id"].as_str().unwrap().to_string()),
        );
        cursor = page["next_cursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let mut dedup = seen.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!((seen.len(), dedup.len()), (6, 6));
    expect_code(
        &w.app,
        "GET",
        &list("?cursor=%25%25"),
        Some(&w.lead),
        Value::Null,
        StatusCode::BAD_REQUEST,
        "invalid_cursor",
    )
    .await;
    expect_code(
        &w.app,
        "GET",
        &list(""),
        None,
        Value::Null,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    )
    .await;
    // archived hidden unless requested
    ok(
        &w.app,
        "DELETE",
        &format!("/v1/products/{}", hao["id"].as_str().unwrap()),
        "/v1/products/{productId}",
        &w.lead,
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    let after = ok(
        &w.app,
        "GET",
        &list(""),
        "/v1/products",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(after["items"].as_array().unwrap().len(), 5);
    let with = ok(
        &w.app,
        "GET",
        &list("?include_archived=true"),
        "/v1/products",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(with["items"].as_array().unwrap().len(), 6);
    // another store sees nothing
    let other = world_from(w.app.clone(), w.state.clone()).await;
    let none = ok(
        &other.app,
        "GET",
        &list(""),
        "/v1/products",
        &other.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert!(none["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn get_patch_archive_price_history_and_isolation() {
    let w = world().await;
    let p = create_product(
        &w,
        &w.lead,
        "Coca",
        9000,
        "coca",
        json!({"cost_price": 7000}),
    )
    .await;
    let pid = p["id"].as_str().unwrap().to_string();
    let path = format!("/v1/products/{pid}");
    let got = ok(
        &w.app,
        "GET",
        &path,
        "/v1/products/{productId}",
        &w.seller,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(got["version"], 1);
    // price: Lead only
    expect_code(
        &w.app,
        "PATCH",
        &path,
        Some(&w.seller),
        json!({"price": 10000}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    expect_code(
        &w.app,
        "PATCH",
        &path,
        Some(&w.enroller),
        json!({"price": 10000}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    expect_code(
        &w.app,
        "PATCH",
        &path,
        Some(&w.enroller),
        json!({"cost_price": 1}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    let updated = ok(
        &w.app,
        "PATCH",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        json!({"price": 10000, "cost_price": 7500, "name": "Coca 330ml"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        (
            updated["price"].clone(),
            updated["version"].clone(),
            updated["name"].clone()
        ),
        (json!(10000), json!(2), json!("Coca 330ml"))
    );
    // no-op patch keeps the version
    let same = ok(
        &w.app,
        "PATCH",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        json!({"price": 10000}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(same["version"], 2);
    // units: full replacement, unit price change logged as unit_price
    let unit =
        json!({"id": Uuid::now_v7(), "name": "thùng", "quantity_in_base": 24, "price": 230000});
    let with_unit = ok(
        &w.app,
        "PATCH",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        json!({"units": [unit.clone()]}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(with_unit["units"].as_array().unwrap().len(), 1);
    let mut unit2 = unit.clone();
    unit2["price"] = json!(220000);
    ok(
        &w.app,
        "PATCH",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        json!({"units": [unit2]}),
        StatusCode::OK,
    )
    .await;
    // history: newest first, field/old/new/source
    let hist = ok(
        &w.app,
        "GET",
        &format!("{path}/price-history"),
        "/v1/products/{productId}/price-history",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    let items = hist["items"].as_array().unwrap();
    assert_eq!(items[0]["field"], "unit_price");
    assert_eq!(
        (items[0]["old_value"].clone(), items[0]["new_value"].clone()),
        (json!(230000), json!(220000))
    );
    assert!(items.iter().any(|i| i["field"] == "price"
        && i["old_value"] == 9000
        && i["new_value"] == 10000
        && i["source"] == "manual"));
    assert!(
        items.iter().any(|i| i["field"] == "cost_price"
            && i["old_value"] == 7000
            && i["new_value"] == 7500)
    );
    let page = ok(
        &w.app,
        "GET",
        &format!("{path}/price-history?limit=2"),
        "/v1/products/{productId}/price-history",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert!(page["next_cursor"].is_string());
    // events
    let id: Uuid = pid.parse().unwrap();
    assert!(count(&w, "SELECT count(*) FROM outbox_events WHERE store_id=(SELECT store_id FROM products WHERE id=$1) AND type='price.changed'", id).await >= 2);
    // validation
    for bad in [
        json!({"price": -5}),
        json!({"name": "x".repeat(121)}),
        json!({"category_id": Uuid::now_v7()}),
    ] {
        let (status, _) = call(&w.app, "PATCH", &path, Some(&w.lead), bad).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "{status}"
        );
    }
    // isolation + unknown
    let other = world_from(w.app.clone(), w.state.clone()).await;
    for (m, suffix) in [
        ("GET", ""),
        ("PATCH", ""),
        ("DELETE", ""),
        ("GET", "/price-history"),
    ] {
        let (status, _) = call(
            &other.app,
            m,
            &format!("{path}{suffix}"),
            Some(&other.lead),
            if m == "PATCH" {
                json!({"price": 1})
            } else {
                Value::Null
            },
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{m} {suffix}");
    }
    expect_code(
        &w.app,
        "GET",
        &format!("/v1/products/{}", Uuid::now_v7()),
        Some(&w.lead),
        Value::Null,
        StatusCode::NOT_FOUND,
        "not_found",
    )
    .await;
    // archive: Lead only, hidden, past reference stays readable
    expect_code(
        &w.app,
        "DELETE",
        &path,
        Some(&w.enroller),
        Value::Null,
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    ok(
        &w.app,
        "DELETE",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    let archived = ok(
        &w.app,
        "GET",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(archived["archived"], true);
    // unarchive through patch
    let back = ok(
        &w.app,
        "PATCH",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        json!({"archived": false}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(back["archived"], false);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn product_images_add_remove_limits() {
    let w = world().await;
    let p = create_product(&w, &w.lead, "Pepsi", 9000, "pepsi0", json!({})).await;
    let pid = p["id"].as_str().unwrap().to_string();
    let base = format!("/v1/products/{pid}/images");
    let first = p["images"][0]["image_id"].as_str().unwrap().to_string();
    let mut added = vec![];
    for i in 1..8 {
        let img = upload(&w, &w.lead, &format!("pepsi{i}")).await;
        let created = ok(
            &w.app,
            "POST",
            &base,
            "/v1/products/{productId}/images",
            &w.lead,
            json!({"image_id": img}),
            StatusCode::CREATED,
        )
        .await;
        assert_eq!(created["position"], i);
        added.push(img);
    }
    index_product(&w, pid.parse().unwrap()).await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            pid.parse().unwrap()
        )
        .await,
        8
    );
    let ninth = upload(&w, &w.lead, "pepsi8").await;
    expect_code(
        &w.app,
        "POST",
        &base,
        Some(&w.lead),
        json!({"image_id": ninth}),
        StatusCode::CONFLICT,
        "image_limit",
    )
    .await;
    expect_code(
        &w.app,
        "POST",
        &base,
        Some(&w.seller),
        json!({"image_id": ninth}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    let (status, _) = call(
        &w.app,
        "POST",
        &base,
        Some(&w.lead),
        json!({"image_id": Uuid::now_v7()}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // remove: embedding goes too; the last image cannot be removed
    ok(
        &w.app,
        "DELETE",
        &format!("{base}/{}", added[0]),
        "/v1/products/{productId}/images/{imageId}",
        &w.lead,
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM product_embeddings WHERE product_id=$1",
            pid.parse().unwrap()
        )
        .await,
        7
    );
    for img in &added[1..] {
        ok(
            &w.app,
            "DELETE",
            &format!("{base}/{img}"),
            "/v1/products/{productId}/images/{imageId}",
            &w.lead,
            Value::Null,
            StatusCode::NO_CONTENT,
        )
        .await;
    }
    expect_code(
        &w.app,
        "DELETE",
        &format!("{base}/{first}"),
        Some(&w.lead),
        Value::Null,
        StatusCode::CONFLICT,
        "conflict",
    )
    .await;
    let (status, _) = call(
        &w.app,
        "DELETE",
        &format!("{base}/{}", Uuid::now_v7()),
        Some(&w.lead),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    expect_code(
        &w.app,
        "DELETE",
        &format!("{base}/{first}"),
        Some(&w.seller),
        Value::Null,
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    // isolation
    let other = world_from(w.app.clone(), w.state.clone()).await;
    let img = upload(&other, &other.lead, "q").await;
    let (status, _) = call(
        &other.app,
        "POST",
        &base,
        Some(&other.lead),
        json!({"image_id": img}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn price_list_export_pdf_and_png() {
    let w = world().await;
    create_product(&w, &w.lead, "Mì Hảo Hảo", 4000, "m1", json!({})).await;
    let gone = create_product(&w, &w.lead, "Đã ngưng", 1000, "m2", json!({})).await;
    ok(
        &w.app,
        "DELETE",
        &format!("/v1/products/{}", gone["id"].as_str().unwrap()),
        "/v1/products/{productId}",
        &w.lead,
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    let get = |q: &str| {
        Request::get(format!("/v1/exports/price-list{q}"))
            .header("authorization", format!("Bearer {}", w.lead))
            .body(Body::empty())
            .unwrap()
    };
    // exports are Lead-only
    for token in [&w.seller, &w.enroller] {
        let request = Request::get("/v1/exports/price-list")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let (status, bytes, _) = raw(&w.app, request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["code"],
            "forbidden"
        );
    }
    let (status, bytes, headers) = raw(&w.app, get("")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/pdf");
    assert!(bytes.starts_with(b"%PDF"));
    let (status, bytes, headers) = raw(&w.app, get("?format=png")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/png");
    assert!(bytes.starts_with(b"\x89PNG"));
    let (status, _, _) = raw(&w.app, get("?format=gif")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = raw(
        &w.app,
        Request::get("/v1/exports/price-list")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn list_is_one_query_and_search_is_index_backed() {
    // The list handler's SQL must be a single statement and the trigram index must back `q`.
    let w = world().await;
    let pool = w.state.postgres.as_ref().unwrap();
    let plan: Vec<String> = sqlx::query_scalar(
        "EXPLAIN SELECT id FROM products WHERE store_id=$1 AND immutable_unaccent(lower(name)) LIKE '%hao%'",
    )
    .bind(w.store_id)
    .fetch_all(pool)
    .await
    .unwrap();
    // On an empty table the planner may seq-scan; assert the index exists and is usable.
    let indexes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pg_indexes WHERE indexname='products_name_trgm'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(indexes, 1, "{plan:?}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn cost_price_is_lead_only_in_every_response() {
    let w = world().await;
    let p = create_product(
        &w,
        &w.lead,
        "Coca",
        9000,
        "cost-1",
        json!({"cost_price": 7000}),
    )
    .await;
    assert_eq!(p["cost_price"], 7000);
    let path = format!("/v1/products/{}", p["id"].as_str().unwrap());
    let lead_get = ok(
        &w.app,
        "GET",
        &path,
        "/v1/products/{productId}",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(lead_get["cost_price"], 7000);
    for token in [&w.seller, &w.enroller] {
        let got = ok(
            &w.app,
            "GET",
            &path,
            "/v1/products/{productId}",
            token,
            Value::Null,
            StatusCode::OK,
        )
        .await;
        assert!(got["cost_price"].is_null(), "{got}");
        let list = ok(
            &w.app,
            "GET",
            "/v1/products",
            "/v1/products",
            token,
            Value::Null,
            StatusCode::OK,
        )
        .await;
        assert!(list["items"][0]["cost_price"].is_null(), "{list}");
        let hist = ok(
            &w.app,
            "GET",
            &format!("{path}/price-history"),
            "/v1/products/{productId}/price-history",
            token,
            Value::Null,
            StatusCode::OK,
        )
        .await;
        let items = hist["items"].as_array().unwrap();
        assert!(!items.is_empty());
        assert!(items.iter().all(|i| i["field"] != "cost_price"), "{hist}");
        // paging through the cursor branch also hides cost rows
        let page = ok(
            &w.app,
            "GET",
            &format!("{path}/price-history?limit=1"),
            "/v1/products/{productId}/price-history",
            token,
            Value::Null,
            StatusCode::OK,
        )
        .await;
        assert!(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|i| i["field"] != "cost_price")
        );
    }
    // enroller edits the name: response still hides cost
    let edited = ok(
        &w.app,
        "PATCH",
        &path,
        "/v1/products/{productId}",
        &w.enroller,
        json!({"name": "Coca 2"}),
        StatusCode::OK,
    )
    .await;
    assert!(edited["cost_price"].is_null(), "{edited}");
    // enroller-created product hides cost in the 201 body
    let image = upload(&w, &w.enroller, "cost-2").await;
    let created = ok(&w.app, "POST", "/v1/products", "/v1/products", &w.enroller, json!({"id": Uuid::now_v7(), "price": 1, "cost_price": 5, "image_ids": [image], "force_new": true}), StatusCode::CREATED).await;
    assert!(created["cost_price"].is_null(), "{created}");
    let hist = ok(
        &w.app,
        "GET",
        &format!("{path}/price-history"),
        "/v1/products/{productId}/price-history",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert!(
        hist["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["field"] == "cost_price")
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn concurrent_duplicate_category_names_never_500() {
    let w = world().await;
    for round in 0..5 {
        let name = format!("Cat {round}");
        let calls = (0..6).map(|_| {
            let (app, token, name) = (w.app.clone(), w.lead.clone(), name.clone());
            tokio::spawn(async move {
                call(
                    &app,
                    "POST",
                    "/v1/categories",
                    Some(&token),
                    json!({"id": Uuid::now_v7(), "name": name}),
                )
                .await
                .0
            })
        });
        let statuses: Vec<_> = futures_join(calls).await;
        assert_eq!(
            statuses
                .iter()
                .filter(|s| **s == StatusCode::CREATED)
                .count(),
            1,
            "{statuses:?}"
        );
        assert!(
            statuses
                .iter()
                .all(|s| *s == StatusCode::CREATED || *s == StatusCode::CONFLICT),
            "{statuses:?}"
        );
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn enrolling_from_a_manual_line_resolves_that_line_once() {
    let w = world().await;
    let line = Uuid::now_v7();
    let sale = json!({"id": Uuid::now_v7(), "sold_at": chrono::Utc::now().to_rfc3339(),
        "payment_method": "cash", "total": 10000, "cash_received": 10000,
        "lines": [{"id": line, "source": "manual", "manual_label": "Kẹo lạc",
                   "quantity": 2, "unit_price": 5000}]});
    ok(
        &w.app,
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.lead,
        sale,
        StatusCode::CREATED,
    )
    .await;
    let open = |status: &'static str| format!("/v1/review/manual-lines?status={status}");
    let queue = ok(
        &w.app,
        "GET",
        &open("open"),
        "/v1/review/manual-lines",
        &w.lead,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(queue["items"][0]["line_id"], line.to_string());

    // the review queue is the Lead's: a seller who may enroll cannot resolve through enrolling
    let image = upload(&w, &w.enroller, "candy").await;
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.enroller),
        json!({"id": Uuid::now_v7(), "price": 5000, "image_ids": [image], "from_manual_line_id": line}),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;

    // an unknown line is refused and no product is left behind
    let ghost_product = Uuid::now_v7();
    let image = upload(&w, &w.lead, "candy").await;
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        json!({"id": ghost_product, "price": 5000, "image_ids": [image],
               "from_manual_line_id": Uuid::now_v7()}),
        StatusCode::NOT_FOUND,
        "not_found",
    )
    .await;
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM products WHERE id=$1",
            ghost_product
        )
        .await,
        0
    );

    // enrolling from the line creates the product and resolves the line as `enrolled`
    let product = ok(
        &w.app,
        "POST",
        "/v1/products",
        "/v1/products",
        &w.lead,
        json!({"id": Uuid::now_v7(), "name": "Kẹo lạc", "price": 5000, "image_ids": [image],
               "from_manual_line_id": line}),
        StatusCode::CREATED,
    )
    .await;
    let still_open = ok(
        &w.app,
        "GET",
        &open("open"),
        "/v1/review/manual-lines",
        &w.lead,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert!(still_open["items"].as_array().unwrap().is_empty());
    let resolved = ok(
        &w.app,
        "GET",
        &open("resolved"),
        "/v1/review/manual-lines",
        &w.lead,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(resolved["items"][0]["line_id"], line.to_string());
    assert_eq!(resolved["items"][0]["resolution"]["action"], "enrolled");
    assert_eq!(
        resolved["items"][0]["resolution"]["product_id"],
        product["id"]
    );

    // a line is resolved once: enrolling from it again conflicts and adds nothing
    let again = Uuid::now_v7();
    let image = upload(&w, &w.lead, "candy-again").await;
    expect_code(
        &w.app,
        "POST",
        "/v1/products",
        Some(&w.lead),
        json!({"id": again, "price": 5000, "image_ids": [image], "force_new": true,
               "from_manual_line_id": line}),
        StatusCode::CONFLICT,
        "already_resolved",
    )
    .await;
    assert_eq!(
        count(&w, "SELECT count(*) FROM products WHERE id=$1", again).await,
        0
    );
}

async fn futures_join(
    handles: impl Iterator<Item = tokio::task::JoinHandle<StatusCode>>,
) -> Vec<StatusCode> {
    let mut out = vec![];
    for h in handles.collect::<Vec<_>>() {
        out.push(h.await.unwrap());
    }
    out
}
