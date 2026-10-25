//! Tests for `POST /v1/segment/points` with encoder cache.

mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
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
};
use taphoa_recognition::{MockPointSegmenter, PointSegmenter, Segment};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct MemStore {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    put_delay: Mutex<Option<Duration>>,
}

#[async_trait::async_trait]
impl ObjectStore for MemStore {
    async fn put(&self, key: &str, _: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        let delay = *self.put_delay.lock().unwrap();
        if let Some(d) = delay {
            tokio::time::sleep(d).await;
        }
        self.objects.lock().unwrap().insert(key.into(), bytes);
        Ok(())
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.objects.lock().unwrap().remove(key);
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
        self.objects
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing object {key}"))
    }
}

struct TestWorld {
    app: Router,
    state: AppState,
    store_id: Uuid,
    lead_token: String,
    seller_no_enroll_token: String,
    seller_can_enroll_token: String,
    mock_segmenter: Arc<MockPointSegmenter>,
    photo_image_id: String,
    mem_store: Arc<MemStore>,
}

async fn setup_world(with_segmenter: bool) -> TestWorld {
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
    let store = Arc::new(MemStore::default());
    state.storage = Some(store.clone());

    let mock_segmenter = Arc::new(MockPointSegmenter::new(
        Segment {
            bbox: [100.0, 150.0, 200.0, 250.0],
            score: 0.98,
            area: 45000,
        },
        256,
        192,
    ));
    if with_segmenter {
        state.point_segmenter = Some(mock_segmenter.clone() as Arc<dyn PointSegmenter>);
    }

    let app = router(state.clone());

    // Create a store and lead member
    let device = json!({"name":"counter","platform":"web","app_version":"1.0"});
    let (_, lead_body) = call_api(
        &app,
        "POST",
        "/v1/stores",
        None,
        json!({"store_name":"Segment Points Store","display_name":"Lead Member","device":device}),
    )
    .await;
    let store_id: Uuid = lead_body["store"]["id"].as_str().unwrap().parse().unwrap();
    let lead_token = lead_body["access_token"].as_str().unwrap().to_string();

    // Invite seller without can_enroll
    let (_, invite_no_enroll) = call_api(
        &app,
        "POST",
        "/v1/invites",
        Some(&lead_token),
        json!({"role":"seller","can_enroll":false}),
    )
    .await;
    let (s1, joined_no_enroll) = call_api(
        &app,
        "POST",
        "/v1/auth/join",
        None,
        json!({"invite_token":invite_no_enroll["token"],"display_name":"Seller No Enroll","device":device}),
    )
    .await;
    assert_eq!(s1, StatusCode::CREATED);
    let seller_no_enroll_token = joined_no_enroll["access_token"]
        .as_str()
        .unwrap()
        .to_string();

    // Invite seller with can_enroll
    let (_, invite_can_enroll) = call_api(
        &app,
        "POST",
        "/v1/invites",
        Some(&lead_token),
        json!({"role":"seller","can_enroll":true}),
    )
    .await;
    let (s2, joined_can_enroll) = call_api(
        &app,
        "POST",
        "/v1/auth/join",
        None,
        json!({"invite_token":invite_can_enroll["token"],"display_name":"Seller Can Enroll","device":device}),
    )
    .await;
    assert_eq!(s2, StatusCode::CREATED);
    let seller_can_enroll_token = joined_can_enroll["access_token"]
        .as_str()
        .unwrap()
        .to_string();

    // Upload a valid PNG photo
    let photo_image_id = upload_photo(&app, &lead_token).await;

    TestWorld {
        app,
        state,
        store_id,
        lead_token,
        seller_no_enroll_token,
        seller_can_enroll_token,
        mock_segmenter,
        photo_image_id,
        mem_store: store,
    }
}

async fn upload_photo(app: &Router, token: &str) -> String {
    let img = image::RgbImage::new(1600, 1200);
    let mut photo_bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut photo_bytes, 80);
    encoder.encode_image(&img).unwrap();

    let mut body = b"--b\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nenrollment\r\n--b\r\nContent-Disposition: form-data; name=\"image\"; filename=\"counter.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".to_vec();
    body.extend_from_slice(&photo_bytes);
    body.extend_from_slice(b"\r\n--b--\r\n");

    let req = Request::post("/v1/images")
        .header("content-type", "multipart/form-data; boundary=b")
        .header("authorization", format!("Bearer {token}"))
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()))
        .body(Body::from(body))
        .unwrap();

    let (status, bytes) = raw_call(app, req).await;
    assert_eq!(status, StatusCode::CREATED);
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    json["id"].as_str().unwrap().to_string()
}

async fn raw_call(app: &Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 22)
        .await
        .unwrap()
        .to_vec();
    (status, bytes)
}

async fn call_api(
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
        .header("content-type", "application/json")
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()));
    if let Some(t) = token {
        request = request.header("authorization", format!("Bearer {t}"));
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let (status, bytes) = raw_call(app, request.body(body).unwrap()).await;
    let mut response: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status == StatusCode::CREATED
        && let Some(token) = minted
    {
        response["access_token"] = json!(token);
    }
    (status, response)
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_200_shape_and_contract() {
    let w = setup_world(true).await;
    let contract = Contract::load();

    let req_body = json!({
        "image_id": w.photo_image_id,
        "points": [
            { "x": 800.0, "y": 600.0, "label": 1 }
        ]
    });

    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        req_body,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "response: {body}");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);

    assert_eq!(body["bbox"], json!([100.0, 150.0, 200.0, 250.0]));
    assert_eq!(body["score"], 0.98);
    assert_eq!(body["area"], 45000);

    // Mask shape
    assert_eq!(body["mask"]["width"], 256);
    assert_eq!(body["mask"]["height"], 192);
    let mask_b64 = body["mask"]["png_base64"].as_str().unwrap();
    assert!(!mask_b64.is_empty());

    // Decode mask PNG and verify it is LumaA8 (grey+alpha: luma=255, alpha=mask)
    let mask_png = STANDARD.decode(mask_b64).expect("valid base64 mask");
    let decoded_mask = image::load_from_memory(&mask_png).expect("valid png image");
    assert_eq!(
        decoded_mask.color(),
        image::ColorType::La8,
        "mask PNG must be LumaA8 (grey+alpha)"
    );
    let luma_alpha = decoded_mask.into_luma_alpha8();
    assert_eq!(luma_alpha.width(), 256);
    assert_eq!(luma_alpha.height(), 192);
    for pixel in luma_alpha.pixels() {
        assert_eq!(pixel[0], 255, "luma must be 255 everywhere for tinting");
        assert_eq!(pixel[1], 255, "alpha must match mock mask foreground");
    }

    // Cutout image id exists and is stored
    let cutout_id = body["cutout_image_id"].as_str().unwrap();
    let cutout_uuid: Uuid = cutout_id.parse().unwrap();

    let repo = w.state.image_repository.as_ref().unwrap();
    let cutout_row = repo.get(cutout_uuid, w.store_id).await.unwrap();
    assert!(cutout_row.is_some(), "cutout image row must exist in DB");
    let cutout_row = cutout_row.unwrap();
    assert_eq!(cutout_row.purpose, "crop");

    // Cutout object appears in storage shortly after background upload finishes
    let mut stored = None;
    for _ in 0..20 {
        if let Ok(bytes) = w.mem_store.get(&cutout_row.object_key).await {
            stored = Some(bytes);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        stored.is_some(),
        "cutout object must appear in storage shortly after response"
    );

    // Timings
    assert!(body["timings"]["encode"].is_number());
    assert!(body["timings"]["decode"].is_number());
    assert!(body["timings"]["total"].is_number());

    // Seller with can_enroll also succeeds
    let (s2, body2) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.seller_can_enroll_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [{ "x": 500.0, "y": 400.0, "label": 1 }]
        }),
    )
    .await;
    assert_eq!(s2, StatusCode::OK, "response: {body2}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_cutout_uploads_in_background_non_blocking() {
    let w = setup_world(true).await;

    // Simulate slow object storage PUT (e.g. 300 ms Railway bucket latency)
    *w.mem_store.put_delay.lock().unwrap() = Some(Duration::from_millis(300));

    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [{ "x": 800.0, "y": 600.0, "label": 1 }]
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let cutout_id: Uuid = body["cutout_image_id"].as_str().unwrap().parse().unwrap();
    let repo = w.state.image_repository.as_ref().unwrap();
    let cutout_row = repo.get(cutout_id, w.store_id).await.unwrap().unwrap();

    // Immediately upon response return, the slow PUT is still in-flight and NOT in store
    let immediate_get = w.mem_store.get(&cutout_row.object_key).await;
    assert!(
        immediate_get.is_err(),
        "response returned before slow store put completed; object must not be in store yet"
    );

    // Shortly after, the background upload completes and the object appears in storage
    let mut stored = None;
    for _ in 0..40 {
        if let Ok(bytes) = w.mem_store.get(&cutout_row.object_key).await {
            stored = Some(bytes);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        stored.is_some(),
        "cutout must appear in storage after background upload finishes"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_422_validation_failed_for_0_and_3_points() {
    let w = setup_world(true).await;
    let contract = Contract::load();

    // 0 points -> 422
    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": []
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "validation_failed");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);

    // 3 points -> 422
    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 100.0, "y": 100.0, "label": 1 },
                { "x": 200.0, "y": 200.0, "label": 1 },
                { "x": 300.0, "y": 300.0, "label": 0 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "validation_failed");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);

    // Invalid label (not 0 or 1) -> 422
    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 100.0, "y": 100.0, "label": 2 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "validation_failed");

    // Out of bounds coordinates (>= 1600x1200) -> 422
    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 1700.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "validation_failed");

    // No foreground point (only background label 0) -> 422
    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 100.0, "y": 100.0, "label": 0 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "validation_failed");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_403_seller_without_can_enroll() {
    let w = setup_world(true).await;
    let contract = Contract::load();

    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.seller_no_enroll_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 800.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "forbidden");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_404_unknown_or_other_store_image() {
    let w = setup_world(true).await;
    let contract = Contract::load();

    // Unknown image
    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": Uuid::new_v4(),
            "points": [
                { "x": 800.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "not_found");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);

    // Another store's image
    let w2 = setup_world(true).await;
    let (status2, body2) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w2.photo_image_id,
            "points": [
                { "x": 800.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status2, StatusCode::NOT_FOUND);
    assert_eq!(body2["code"], "not_found");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_503_without_point_segmenter() {
    let w = setup_world(false).await;
    let contract = Contract::load();

    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 800.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "unavailable");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_cache_hit_on_second_call() {
    let w = setup_world(true).await;

    assert_eq!(w.mock_segmenter.encode_calls(), 0);

    // First call: cache miss, runs encode
    let (status1, _body1) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 800.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status1, StatusCode::OK);
    assert_eq!(w.mock_segmenter.encode_calls(), 1);

    // Second call on the SAME image_id: cache hit!
    let (status2, body2) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 820.0, "y": 620.0, "label": 1 },
                { "x": 100.0, "y": 100.0, "label": 0 }
            ]
        }),
    )
    .await;
    assert_eq!(status2, StatusCode::OK);

    // encode_calls remains 1
    assert_eq!(
        w.mock_segmenter.encode_calls(),
        1,
        "second call on same image must hit cache and NOT re-encode"
    );

    // encode timing is 0 on cache hit
    assert_eq!(
        body2["timings"]["encode"], 0,
        "encode timing must be 0 on cache hit"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn test_segment_points_503_when_inference_slots_busy() {
    let w = setup_world(true).await;

    // Acquire the only inference slot permit
    let _permit = w.state.inference_slots.clone().try_acquire_owned().unwrap();

    let (status, body) = call_api(
        &w.app,
        "POST",
        "/v1/segment/points",
        Some(&w.lead_token),
        json!({
            "image_id": w.photo_image_id,
            "points": [
                { "x": 800.0, "y": 600.0, "label": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "unavailable");
}
