//! Recognition scan endpoints (`POST`/`GET /v1/recognition/scans`) against
//! real PostgreSQL, Redis and S3. Colour→vector `TestEmbedder`,
//! `MockSegmenter` and an in-memory vector index keep the recognition side
//! deterministic; the store, member, product rows and object storage are real.

mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
};
use common::Contract;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use taphoa_api::{
    AppState, router,
    storage::{S3Store, StorageConfig},
    vector::{InMemoryVectorIndex, VectorIndex},
};
use taphoa_recognition::{EmbedError, Embedder, MockSegmenter, Segment};
use tokio::sync::Semaphore;
use tower::ServiceExt;
use uuid::Uuid;

/// 384-d unit vector: 128 repetitions of each mean red/green/blue value.
pub struct TestEmbedder;
impl TestEmbedder {
    fn colour_vector(&self, r: f32, g: f32, b: f32) -> Vec<f32> {
        let mut vector = Vec::with_capacity(384);
        for value in [r, g, b] {
            vector.extend(std::iter::repeat_n(value, 128));
        }
        let norm = vector
            .iter()
            .map(|value| f64::from(*value) * f64::from(*value))
            .sum::<f64>()
            .sqrt() as f32;
        vector.iter_mut().for_each(|value| *value /= norm);
        vector
    }
}

impl Embedder for TestEmbedder {
    fn model(&self) -> &str {
        "colour@1"
    }
    fn dim(&self) -> usize {
        384
    }
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        let image = image::ImageReader::new(std::io::Cursor::new(image))
            .with_guessed_format()
            .expect("known format guess")
            .decode()
            .map_err(|error| EmbedError::InvalidImage(error.to_string()))?;
        let mut sums = [0u64; 3];
        let mut count = 0u64;
        for (_, _, pixel) in image.into_rgba8().enumerate_pixels() {
            let image::Rgba([r, g, b, _]) = *pixel;
            sums[0] += u64::from(r);
            sums[1] += u64::from(g);
            sums[2] += u64::from(b);
            count += 1;
        }
        Ok(self.colour_vector(
            sums[0] as f32 / count as f32,
            sums[1] as f32 / count as f32,
            sums[2] as f32 / count as f32,
        ))
    }
}

/// Solid colour patches under the mock segments.
const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const PURPLE: [u8; 3] = [200, 0, 200];
const GREY: [u8; 3] = [30, 30, 30];
const PINK: [u8; 3] = [255, 120, 120];

/// 160×128 PNG with solid patches under the segment boxes:
/// red 0..64×0..64, purple 70..118×0..48, grey 115..147×0..40.
fn draw_photo() -> Vec<u8> {
    let mut image = image::RgbImage::new(160, 128);
    let patch = |image: &mut image::RgbImage, rect: [u32; 4], colour: [u8; 3]| {
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            if (rect[0]..rect[0] + rect[2]).contains(&x)
                && (rect[1]..rect[1] + rect[3]).contains(&y)
            {
                *pixel = image::Rgb(colour);
            }
        }
    };
    patch(&mut image, [0, 0, 64, 64], RED);
    patch(&mut image, [70, 0, 48, 48], PURPLE);
    patch(&mut image, [115, 0, 32, 40], GREY);
    encode_png(image)
}

fn pink_photo() -> Vec<u8> {
    let mut image = image::RgbImage::new(160, 128);
    for (_, _, pixel) in image.enumerate_pixels_mut() {
        *pixel = image::Rgb(PINK);
    }
    encode_png(image)
}

fn encode_png(image: image::RgbImage) -> Vec<u8> {
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    png
}

fn segment(bbox: [f32; 4], score: f32) -> Segment {
    Segment {
        bbox,
        score,
        area: bbox[2] as u32 * bbox[3] as u32,
    }
}

/// Scan segments: two red crops overlap (the smaller duplicate must drop),
/// a purple crop tied between the two products and a grey crop below the
/// floor; equal row heights keep the display order simple.
fn scan_segments() -> Vec<Segment> {
    vec![
        segment([4., 4., 50., 50.], 0.9),
        segment([14., 14., 40., 40.], 0.8),
        segment([75., 10., 30., 30.], 0.85),
        segment([120., 10., 20., 20.], 0.75),
    ]
}

fn pink_segments() -> Vec<Segment> {
    vec![segment([0., 0., 100., 100.], 0.9)]
}

async fn build_state(
    segments: Vec<Segment>,
) -> Option<(Router, AppState, Arc<InMemoryVectorIndex>)> {
    let (Ok(database), Ok(redis)) = (std::env::var("DATABASE_URL"), std::env::var("REDIS_URL"))
    else {
        eprintln!("SKIP recognition integration: set DATABASE_URL and REDIS_URL");
        return None;
    };
    let Some(storage_config) = StorageConfig::from_env().unwrap() else {
        eprintln!("SKIP recognition integration: set all AWS_* storage variables");
        return None;
    };
    let mut state = AppState::connect(Some(&database), Some(&redis), None)
        .await
        .unwrap();
    common::clerk::install(&mut state);
    let index = Arc::new(InMemoryVectorIndex::default());
    state.client_ip = taphoa_api::ratelimit::ClientIpSource::ForwardedFor { hops: 1 };
    state.embedder = Some(Arc::new(TestEmbedder));
    state.vector_index = Some(index.clone() as Arc<dyn VectorIndex>);
    state.inference_slots = Arc::new(Semaphore::new(1));
    state.segmenter = Some(Arc::new(MockSegmenter { segments }));
    let storage = Arc::new(S3Store::new(&storage_config).await);
    if storage_config.create_bucket {
        storage.ensure_bucket().await.unwrap();
    }
    state.storage = Some(storage);
    state.image_url_ttl = storage_config.url_ttl;
    Some((router(state.clone()), state, index))
}

// Fresh, parseable client addresses isolate auth limits between repeated test runs.
fn unique_ip() -> String {
    let b = Uuid::new_v4().into_bytes();
    format!("10.{}.{}.{}", b[0], b[1], b[2])
}

/// Store + lead member + design device; returns (store, member, token).
async fn create_store(app: &Router) -> (Uuid, Uuid, String) {
    let token = common::clerk::token();
    let created = app
        .clone()
        .oneshot(
            Request::post("/v1/stores").header("authorization",format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("x-forwarded-for", unique_ip())
                .body(Body::from(
                    json!({"store_name":"Recognition test","display_name":"Lead","device":{"name":"counter","platform":"web","app_version":"1.0"},"bank_account":{"bank_bin":"970436","account_number":"VN123","account_name":"CO BA"}})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body, _) = read(created).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (
        body["store"]["id"].as_str().unwrap().parse().unwrap(),
        body["member"]["id"].as_str().unwrap().parse().unwrap(),
        token,
    )
}

/// Two colour-identified products; a 12-pack unit only on the red one.
async fn seed_products(
    pool: &PgPool,
    store_id: Uuid,
    member_id: Uuid,
    index: &InMemoryVectorIndex,
) -> (Uuid, Uuid) {
    let embedder = TestEmbedder;
    let mut products = Vec::new();
    for (name, price, colour) in [
        ("Nước mắm Phú Quốc", 25_000i64, RED),
        ("Dầu ăn Kinh Đô", 45_000, BLUE),
    ] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO products (id, store_id, name, price, created_by, request_hash) \
             VALUES ($1, $2, $3, $4, $5, '\\x00'::bytea)",
        )
        .bind(id)
        .bind(store_id)
        .bind(name)
        .bind(price)
        .bind(member_id)
        .execute(pool)
        .await
        .unwrap();
        index
            .upsert(
                store_id,
                id,
                Uuid::new_v4(),
                embedder.model(),
                embedder.colour_vector(
                    f32::from(colour[0]),
                    f32::from(colour[1]),
                    f32::from(colour[2]),
                ),
            )
            .await
            .unwrap();
        products.push(id);
    }
    sqlx::query(
        "INSERT INTO product_units (id, store_id, product_id, name, quantity_in_base, price) \
         VALUES ($1, $2, $3, 'lốc', 12, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(store_id)
    .bind(products[0])
    .bind(276_000i64)
    .execute(pool)
    .await
    .unwrap();
    (products[0], products[1])
}

/// Multipart POST to `POST /v1/recognition/scans`; `image` optional to allow
/// the `image_id` path.
async fn post_scan(
    app: &Router,
    token: &str,
    image: Option<&[u8]>,
    extras: &[(&str, &str)],
) -> (StatusCode, Value, HeaderMap) {
    post_recognition(app, token, "/v1/recognition/scans", image, extras).await
}

async fn post_recognition(
    app: &Router,
    token: &str,
    path: &str,
    image: Option<&[u8]>,
    extras: &[(&str, &str)],
) -> (StatusCode, Value, HeaderMap) {
    let mut body = Vec::new();
    for (name, value) in extras {
        body.extend_from_slice(
            format!("--SCAN\r\ncontent-disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    if let Some(bytes) = image {
        body.extend_from_slice(
            "--SCAN\r\ncontent-disposition: form-data; name=\"image\"; filename=\"photo.png\"\r\ncontent-type: image/png\r\n\r\n"
                .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"--SCAN--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .header("content-type", "multipart/form-data; boundary=SCAN")
                .header("authorization", format!("Bearer {token}"))
                .header("x-forwarded-for", unique_ip())
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    read(response).await
}

async fn read(response: axum::response::Response) -> (StatusCode, Value, HeaderMap) {
    let headers = response.headers().clone();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 32 << 20).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("JSON body")
    };
    (status, body, headers)
}

async fn get_scan(app: &Router, token: &str, scan_id: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/v1/recognition/scans/{scan_id}"))
                .header("authorization", format!("Bearer {token}"))
                .header("x-forwarded-for", unique_ip())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body, _) = read(response).await;
    (status, body)
}

fn approx(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "{actual} is not close to {expected}"
    );
}

/// Scan/time rows on disk: detections in position order, 3 crop thumbnails
/// with purpose `crop`, embeddings stored (dim 384).
async fn assert_persisted(pool: &PgPool, store_id: Uuid, scan_id: &str, red: Uuid) -> (Uuid, i64) {
    let envelope: Value = sqlx::query_scalar("SELECT payload FROM outbox_events WHERE store_id=$1 AND type='scan.completed' AND payload->'data'->>'scan_id'=$2")
        .bind(store_id).bind(scan_id).fetch_one(pool).await.unwrap();
    assert_eq!(envelope["data"]["purpose"], "checkout");
    assert!(envelope["data"]["latency_ms"].as_u64().is_some());
    assert!(matches!(
        envelope["data"]["match_class"].as_str(),
        Some("matched" | "ambiguous" | "unknown")
    ));
    let row: (Uuid, Uuid, i64, Value) = sqlx::query_as(
        "SELECT id, image_id, catalog_version, timings FROM \
         scans WHERE id = $1 AND store_id = $2",
    )
    .bind(scan_id.parse::<Uuid>().unwrap())
    .bind(store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let detections: Vec<(i16, String, Vec<f32>, Uuid)> = sqlx::query_as(
        "SELECT position, match::TEXT, bbox, crop_image_id \
         FROM detections WHERE scan_id = $1 ORDER BY position",
    )
    .bind(row.0)
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(detections.len(), 3);
    assert!(
        detections
            .iter()
            .enumerate()
            .all(|(index, (position, _, _, _))| *position == index as i16)
    );
    let candidates: Vec<Value> = sqlx::query_as::<_, (Value,)>(
        "SELECT candidates FROM detections WHERE scan_id = $1 ORDER BY position",
    )
    .bind(row.0)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|row| row.0)
    .collect();
    assert!(
        candidates
            .iter()
            .any(|hit| hit[0]["product_id"] == red.to_string())
    );
    let crop_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM images WHERE purpose = 'crop' AND store_id = $1")
            .bind(store_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(crop_rows, 3);
    let embedded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM detections WHERE scan_id = $1 AND embedding IS NOT NULL",
    )
    .bind(row.0)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(embedded, 3);
    (row.1, row.2)
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn scan_orders_classes_candidates_and_persists() {
    let Some((app, state, index)) = build_state(scan_segments()).await else {
        return;
    };
    let pool = state.postgres.clone().unwrap();
    let (store_id, member_id, token) = create_store(&app).await;
    let (red, blue) = seed_products(&pool, store_id, member_id, &index).await;

    let (status, body, headers) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(headers.get("content-type").unwrap(), "application/json");
    Contract::load().assert_conforms("/v1/recognition/scans", "post", status, &body);

    let scan_id = body["id"].as_str().unwrap().to_owned();
    let detections = body["detections"].as_array().unwrap();
    assert_eq!(
        detections.len(),
        3,
        "the overlapping red crop is dropped: {body}"
    );
    let classes: Vec<&str> = detections
        .iter()
        .map(|detection| detection["match"].as_str().unwrap())
        .collect();
    assert_eq!(classes, ["matched", "ambiguous", "unknown"]);
    let red_candidates = &detections[0]["candidates"].as_array().unwrap();
    assert_eq!(
        red_candidates[0]["product_id"],
        red.to_string(),
        "candidates are similarity-sorted"
    );
    approx(red_candidates[0]["similarity"].as_f64().unwrap(), 1.0);
    assert_eq!(red_candidates[0]["name"], "Nước mắm Phú Quốc");
    assert_eq!(red_candidates[0]["price"], 25_000);
    assert!(red_candidates[0]["default_unit_id"].is_string());

    let purple = &detections[1]["candidates"].as_array().unwrap();
    assert_eq!(purple.len(), 2);
    approx(purple[0]["similarity"].as_f64().unwrap(), 0.707);
    approx(
        purple[0]["similarity"].as_f64().unwrap(),
        purple[1]["similarity"].as_f64().unwrap(),
    );
    let grey = &detections[2]["candidates"].as_array().unwrap();
    approx(grey[0]["similarity"].as_f64().unwrap(), 0.577);

    let left_x: Vec<f64> = detections
        .iter()
        .map(|detection| detection["bbox"][0].as_f64().unwrap())
        .collect();
    assert!(
        left_x[0] < left_x[1] && left_x[1] < left_x[2],
        "display order is left-to-right: {left_x:?}"
    );
    assert_eq!(body["pipeline"]["segmenter"], "mobilesam-onnx@1");
    assert_eq!(body["pipeline"]["embedder"], "colour@1");
    for key in ["segment", "embed", "search", "total"] {
        assert!(
            body["timings_ms"][key].is_i64(),
            "timings_ms.{key} missing: {}",
            body["timings_ms"]
        );
    }
    assert!(body["image"]["id"].is_string());
    assert_eq!(body["mode"], "multi");
    assert_eq!(body["purpose"], "checkout");

    let (image_id, catalog_version) = assert_persisted(&pool, store_id, &scan_id, red).await;
    assert_eq!(body["image"]["id"], image_id.to_string());
    assert_eq!(body["pipeline"]["catalog_version"], catalog_version);

    let latest: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(seq), 0) FROM change_log WHERE store_id = $1")
            .bind(store_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(catalog_version, latest);
    let _ = blue;
}

/// Exercise empty/singleton arrays as well as a full 24-detection multi scan.
/// Distinct boxes and mixed colours catch array alignment, ordering and JSONB
/// snapshot regressions; embeddings are read directly because the API hides them.
#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn multi_scan_many_detections_round_trips_unchanged() {
    for count in [0, 1, 24] {
        let mut photo = image::RgbImage::new(384, 256);
        let mut segments = Vec::new();
        let colours = [RED, PURPLE, GREY, BLUE];
        for i in 0..count {
            let (x, y) = ((i % 6) * 64, (i / 6) * 64);
            let colour = colours[i as usize % colours.len()];
            for py in y..y + 64 {
                for px in x..x + 64 {
                    photo.put_pixel(px, py, image::Rgb(colour));
                }
            }
            segments.push(segment(
                [x as f32 + 16., y as f32 + 16., 20. + (i % 3) as f32, 24.],
                0.5 + i as f32 * 0.015,
            ));
        }
        // The segmenter order deliberately disagrees with row-major display order.
        let Some((app, state, index)) = build_state(segments.iter().rev().cloned().collect()).await
        else {
            return;
        };
        let pool = state.postgres.clone().unwrap();
        let (store_id, member_id, token) = create_store(&app).await;
        seed_products(&pool, store_id, member_id, &index).await;
        let (status, body, _) =
            post_scan(&app, &token, Some(&encode_png(photo)), &[("mode", "multi")]).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let scan_id = body["id"].as_str().unwrap();
        let posted = body["detections"].as_array().unwrap();
        assert_eq!(posted.len(), count as usize);
        let (status, fetched) = get_scan(&app, &token, scan_id).await;
        assert_eq!(status, StatusCode::OK, "{fetched}");
        for key in ["id", "mode", "purpose", "pipeline", "created_at"] {
            assert_eq!(fetched[key], body[key], "{key}");
        }
        let stored: Vec<(Value, Option<pgvector::Vector>, Value)> = sqlx::query_as(
            "SELECT to_jsonb(d) - 'embedding', d.embedding, to_jsonb(i) \
             FROM detections d JOIN images i ON i.id = d.crop_image_id \
             WHERE d.scan_id = $1 ORDER BY d.position",
        )
        .bind(scan_id.parse::<Uuid>().unwrap())
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(stored.len(), posted.len());
        for (position, ((row, embedding, crop), expected)) in
            stored.iter().zip(&segments).enumerate()
        {
            let detection = &posted[position];
            let loaded = &fetched["detections"][position];
            for key in ["id", "match"] {
                assert_eq!(row[key], detection[key], "persisted {key} at {position}");
            }
            for key in ["id", "bbox", "score", "match"] {
                assert_eq!(loaded[key], detection[key], "GET {key} at {position}");
            }
            assert_eq!(row["position"], position);
            assert_eq!(row["store_id"], store_id.to_string());
            assert_eq!(row["scan_id"], scan_id);
            let bbox: [f32; 4] = serde_json::from_value(row["bbox"].clone()).unwrap();
            assert_eq!(bbox, expected.bbox);
            assert_eq!(
                bbox,
                serde_json::from_value::<[f32; 4]>(detection["bbox"].clone()).unwrap()
            );
            assert!((row["score"].as_f64().unwrap() - f64::from(expected.score)).abs() < 1e-7);
            assert!(
                (row["score"].as_f64().unwrap() - detection["score"].as_f64().unwrap()).abs()
                    < 1e-7
            );
            assert_eq!(row["area"], expected.area);
            assert_eq!(row["crop_image_id"], crop["id"]);
            assert_eq!(crop["store_id"], store_id.to_string());
            assert_eq!(crop["uploaded_by"], member_id.to_string());
            assert_eq!(crop["content_type"], "image/jpeg");
            assert_eq!(crop["purpose"], "crop");
            assert!(crop["byte_size"].as_i64().unwrap() > 0);
            let crop_key = crop["object_key"].as_str().unwrap();
            assert!(detection["crop_url"].as_str().unwrap().contains(crop_key));
            // Presigned URLs are generated afresh; all persisted candidate fields
            // must agree, including their order and optional default unit ids.
            let snapshots = row["candidates"].as_array().unwrap();
            let candidates = detection["candidates"].as_array().unwrap();
            assert_eq!(snapshots.len(), candidates.len());
            for (snapshot, candidate) in snapshots.iter().zip(candidates) {
                for key in ["product_id", "name", "price", "default_unit_id"] {
                    assert_eq!(snapshot[key], candidate[key]);
                }
                // JSONB stores the f32 snapshot through serde_json::Value;
                // the API serializes f32 directly with shorter decimal text.
                assert!(
                    (snapshot["similarity"].as_f64().unwrap()
                        - candidate["similarity"].as_f64().unwrap())
                    .abs()
                        < 1e-7
                );
            }
            assert_eq!(loaded["candidates"], detection["candidates"]);
            let [r, g, b] = colours[position % colours.len()];
            assert_eq!(
                embedding.as_ref().unwrap().to_vec(),
                TestEmbedder.colour_vector(f32::from(r), f32::from(g), f32::from(b)),
            );
        }
        let crops: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM images WHERE store_id = $1 AND purpose = 'crop'",
        )
        .bind(store_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(crops, i64::from(count));
        let completed: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM outbox_events WHERE store_id = $1 AND type = 'scan.completed' \
             AND payload->'data'->>'scan_id' = $2",
        )
        .bind(store_id)
        .bind(scan_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(completed, 1);
    }
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn get_scan_and_cross_store_404() {
    let Some((app, state, index)) = build_state(scan_segments()).await else {
        return;
    };
    let pool = state.postgres.clone().unwrap();
    let (store_id, member_id, token) = create_store(&app).await;
    let (red, blue) = seed_products(&pool, store_id, member_id, &index).await;
    let (_, posted, _) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    let scan_id = posted["id"].as_str().unwrap().to_owned();
    let _ = (store_id, red, blue);

    let (status, body) = get_scan(&app, &token, &scan_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["id"], scan_id);
    Contract::load().assert_conforms("/v1/recognition/scans/{scanId}", "get", status, &body);
    assert_eq!(body["detections"][0]["match"], "matched");
    assert!(body["detections"][0]["crop_url"].is_string());

    let (_, _, other) = create_store(&app).await;
    let (status, body) = get_scan(&app, &other, &scan_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "not_found");

    let (status, body) = get_scan(&app, &token, &Uuid::new_v4().to_string()).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "not_found");
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn request_validation() {
    let Some((app, _, _)) = build_state(scan_segments()).await else {
        return;
    };
    let (_, _, token) = create_store(&app).await;
    let photo = draw_photo();

    let (status, body, _) = post_scan(&app, "not-a-token", Some(&photo), &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (status, body, _) = post_scan(&app, &token, Some(&photo), &[("mode", "pano")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body, _) = post_scan(&app, &token, Some(&photo), &[("top_k", "6")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body, _) = post_scan(&app, &token, None, &[("mode", "multi")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body, _) = post_scan(&app, &token, Some(&[7u8; 8192]), &[]).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{body}");
    assert_eq!(body["code"], "unsupported_media_type");

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/recognition/scans")
                .header("content-type", "multipart/form-data; boundary=SCAN")
                .header("authorization", format!("Bearer {token}"))
                .header("x-forwarded-for", unique_ip())
                .body(Body::from(build_flagged_body("text/plain", &photo)))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body, _) = read(response).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{body}");

    let (status, body, _) = post_scan(&app, &token, Some(&vec![7u8; 11 << 20]), &[]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
}

fn build_flagged_body(content_type: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(
        "--SCAN\r\ncontent-disposition: form-data; name=\"image\"; filename=\"photo.png\"\r\n"
            .as_bytes(),
    );
    body.extend_from_slice(format!("content-type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--SCAN--\r\n");
    body
}

async fn upload_image(app: &Router, token: &str, bytes: &[u8]) -> (StatusCode, Value) {
    let mut body = Vec::new();
    body.extend_from_slice(
        "--SCAN\r\ncontent-disposition: form-data; name=\"purpose\"\r\n\r\ncheckout\r\n".as_bytes(),
    );
    body.extend_from_slice(
        "--SCAN\r\ncontent-disposition: form-data; name=\"image\"; filename=\"photo.png\"\r\ncontent-type: image/png\r\n\r\n"
            .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--SCAN--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/images")
                .header("content-type", "multipart/form-data; boundary=SCAN")
                .header("authorization", format!("Bearer {token}"))
                .header("x-forwarded-for", unique_ip())
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, result, _) = read(response).await;
    (status, result)
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn image_id_path_reuses_the_row() {
    let Some((app, state, index)) = build_state(vec![segment([20., 20., 60., 60.], 0.9)]).await
    else {
        return;
    };
    let pool = state.postgres.clone().unwrap();
    let (store_id, member_id, token) = create_store(&app).await;
    let (red, blue) = seed_products(&pool, store_id, member_id, &index).await;
    let (status, uploaded) = upload_image(&app, &token, &pink_photo()).await;
    assert_eq!(status, StatusCode::CREATED, "{uploaded}");
    let image_id = uploaded["id"].as_str().unwrap().to_owned();

    let (status, body, _) = post_scan(
        &app,
        &token,
        None,
        &[("image_id", &image_id), ("purpose", "checkout")],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    Contract::load().assert_conforms("/v1/recognition/scans", "post", status, &body);
    assert_eq!(body["image"]["id"], image_id, "the uploaded row is reused");
    assert_eq!(body["detections"][0]["match"], "matched");

    let unknown = Uuid::new_v4().to_string();
    let (status, body, _) = post_scan(&app, &token, None, &[("image_id", &unknown)]).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body, _) = post_scan(&app, &token, None, &[("image_id", "zz")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let _ = (red, blue);
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL and REDIS_URL"]
async fn busy_returns_retry_after() {
    let Some((app, state, _)) = build_state(scan_segments()).await else {
        return;
    };
    let (_, _, token) = create_store(&app).await;
    let permit = state.inference_slots.clone().acquire_owned().await.unwrap();
    let (status, body, headers) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["code"], "unavailable");
    assert_eq!(headers.get("retry-after"), Some(&"1".parse().unwrap()));
    drop(permit);
    let (status, body, _) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn rejected_formats_and_errors_release_the_inference_slot() {
    let Some((app, state, _)) = build_state(scan_segments()).await else {
        return;
    };
    let (_, _, token) = create_store(&app).await;

    // Declared as image/png, but WebP and GIF bytes never reach a decoder: 415 before any work.
    for fake in [&b"RIFF\0\0\0\0WEBPVP8 payload"[..], &b"GIF89a payload"[..]] {
        let (status, body, _) = post_scan(&app, &token, Some(fake), &[]).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{body}");
        assert_eq!(state.inference_slots.available_permits(), 1);
    }

    // A truncated JPEG passes the magic-byte check and fails inside the blocking task.
    let (status, body, _) = post_scan(&app, &token, Some(b"\xff\xd8\xff\xe0 truncated"), &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        state.inference_slots.available_permits(),
        1,
        "the permit must be released after an inference error"
    );

    // The slot is still usable.
    let (status, body, _) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(state.inference_slots.available_permits(), 1);
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn missing_models_are_unavailable() {
    let Some((_app, mut state, _)) = build_state(scan_segments()).await else {
        return;
    };
    state.segmenter = None;
    let app = router(state.clone());
    let (_, _, token) = create_store(&app).await;
    let (status, body, headers) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["code"], "unavailable");
    assert!(headers.get("retry-after").is_none());
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn enrollment_duplicate_threshold_lowers_match() {
    let Some((app, state, index)) = build_state(pink_segments()).await else {
        return;
    };
    let pool = state.postgres.clone().unwrap();
    let (store_id, member_id, token) = create_store(&app).await;
    let (red, blue) = seed_products(&pool, store_id, member_id, &index).await;
    let photo = pink_photo();

    let (_, checkout, _) = post_scan(&app, &token, Some(&photo), &[]).await;
    assert_eq!(checkout["detections"][0]["match"], "matched", "{checkout}");
    let (_, enrollment, _) =
        post_scan(&app, &token, Some(&photo), &[("purpose", "enrollment")]).await;
    assert_eq!(
        enrollment["detections"][0]["match"], "ambiguous",
        "0.83 must be under the 0.88 duplicate threshold: {enrollment}"
    );
    let _ = (store_id, red, blue);
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn scan_without_detector_has_document_signal() {
    let (app, _, _) = build_state(scan_segments())
        .await
        .expect("test services configured");
    let (_, _, token) = create_store(&app).await;
    let (status, body, _) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["document"],
        json!({"detected":false,"score":0.0,"text_lines":0,"line_boxes":[]})
    );
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn scan_fake_document_detector_true_false_and_get() {
    use taphoa_recognition::ocr::{FakeTextDetector, TextBox};
    let (_, mut state, _) = build_state(scan_segments())
        .await
        .expect("test services configured");
    for detected in [true, false] {
        state.text_detector = Some(Arc::new(FakeTextDetector {
            boxes: if detected {
                (0..6)
                    .map(|i| TextBox {
                        bbox: [0., i as f32 * 20., 100., 10.],
                        score: 0.9,
                    })
                    .collect()
            } else {
                vec![]
            },
        }));
        let app = router(state.clone());
        let (_, _, token) = create_store(&app).await;
        let (status, body, _) = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["document"]["detected"], detected);
        assert_eq!(body["document"]["text_lines"], if detected { 6 } else { 0 });
        let expected_boxes: Vec<_> = if detected {
            (0..6)
                .map(|i| json!([0., i as f32 * 20. / 128., 100. / 160., 10. / 128.]))
                .collect()
        } else {
            vec![]
        };
        assert_eq!(body["document"]["line_boxes"], json!(expected_boxes));
        Contract::load().assert_conforms("/v1/recognition/scans", "post", status, &body);
        let (status, got) = get_scan(&app, &token, body["id"].as_str().unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(got["document"], body["document"]);
        Contract::load().assert_conforms("/v1/recognition/scans/{scanId}", "get", status, &got);
        // Old timing snapshots keep their detection/count when boxes are absent.
        sqlx::query("UPDATE scans SET timings = timings #- '{document,line_boxes}' WHERE id = $1")
            .bind(body["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .execute(state.postgres.as_ref().unwrap())
            .await
            .unwrap();
        let (status, legacy) = get_scan(&app, &token, body["id"].as_str().unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        let mut expected = body["document"].clone();
        expected["line_boxes"] = json!([]);
        assert_eq!(legacy["document"], expected);
    }
}

const PROBES: &str = "/v1/recognition/document-probes";

/// Auth uses real membership rows; the preview has no storage or other inference ports.
async fn probe_state(with_detector: bool) -> AppState {
    use taphoa_recognition::ocr::{FakeTextDetector, TextBox};
    let mut state = AppState::connect(
        Some(&std::env::var("DATABASE_URL").expect("DATABASE_URL")),
        Some(&std::env::var("REDIS_URL").expect("REDIS_URL")),
        None,
    )
    .await
    .unwrap();
    common::clerk::install(&mut state);
    state.client_ip = taphoa_api::ratelimit::ClientIpSource::ForwardedFor { hops: 1 };
    if with_detector {
        state.text_detector = Some(Arc::new(FakeTextDetector {
            boxes: (0..6)
                .rev()
                .flat_map(|i| {
                    [
                        TextBox {
                            bbox: [0., i as f32 * 20., 40., 10.],
                            score: 0.9,
                        },
                        TextBox {
                            bbox: [60., i as f32 * 20., 40., 10.],
                            score: 0.9,
                        },
                    ]
                })
                .collect(),
        }));
    }
    state
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn document_probe_returns_grouped_signal_without_scan_services_or_writes() {
    let state = probe_state(true).await;
    assert!(state.storage.is_none());
    assert!(state.segmenter.is_none());
    assert!(state.embedder.is_none());
    assert!(state.vector_index.is_none());
    let app = router(state.clone());
    let (store_id, _, token) = create_store(&app).await;
    let pool = state.postgres.as_ref().unwrap();
    let counts = || async {
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT (SELECT count(*) FROM scans WHERE store_id=$1), (SELECT count(*) FROM images WHERE store_id=$1)"
        ).bind(store_id).fetch_one(pool).await.unwrap()
    };
    let before = counts().await;
    let png = draw_photo();
    let mut jpeg = std::io::Cursor::new(Vec::new());
    image::load_from_memory(&png)
        .unwrap()
        .write_to(&mut jpeg, image::ImageFormat::Jpeg)
        .unwrap();
    for photo in [&png, jpeg.get_ref()] {
        let (status, body, _) = post_recognition(&app, &token, PROBES, Some(photo), &[]).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["detected"], true);
        assert_eq!(body["text_lines"], 6);
        assert_eq!(body["score"], 1.);
        let expected: Vec<_> = (0..6)
            .map(|i| json!([0., i as f32 * 20. / 128., 100. / 160., 10. / 128.]))
            .collect();
        assert_eq!(body["line_boxes"], json!(expected));
        Contract::load().assert_conforms(PROBES, "post", status, &body);
    }
    assert_eq!(
        counts().await,
        before,
        "probes must not persist scans or images"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn document_probe_without_detector_returns_ocr_unavailable() {
    let app = router(probe_state(false).await);
    let (_, _, token) = create_store(&app).await;
    let (status, body, _) = post_recognition(&app, &token, PROBES, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "ocr_unavailable");
    Contract::load().assert_conforms(PROBES, "post", status, &body);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn document_probe_enforces_image_limit_and_validates_input() {
    let app = router(probe_state(true).await);
    let (_, _, token) = create_store(&app).await;
    let mut photo = draw_photo();
    photo.resize(512 * 1024, 0);
    let (status, body, _) = post_recognition(&app, &token, PROBES, Some(&photo), &[]).await;
    assert_eq!(status, StatusCode::OK, "exactly 512 KB allowed: {body}");
    photo.push(0);
    let (status, body, _) = post_recognition(&app, &token, PROBES, Some(&photo), &[]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["code"], "payload_too_large");
    Contract::load().assert_conforms(PROBES, "post", status, &body);
    for (image, expected) in [
        (None, StatusCode::BAD_REQUEST),
        (
            Some(b"not an image".as_slice()),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            Some(b"\x89PNG\r\n\x1a\ninvalid".as_slice()),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let (status, body, _) = post_recognition(&app, &token, PROBES, image, &[]).await;
        assert_eq!(status, expected, "{body}");
        Contract::load().assert_conforms(PROBES, "post", status, &body);
    }
    let (status, _, _) = post_recognition(&app, "", PROBES, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn document_probe_rate_limits_per_member_with_standard_retry_shape() {
    let state = probe_state(true).await;
    let app = router(state.clone());
    let (store_id, _, token) = create_store(&app).await;
    let photo = draw_photo();
    for _ in 0..40 {
        let (status, body, _) = post_recognition(&app, &token, PROBES, Some(&photo), &[]).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body, headers) = post_recognition(&app, &token, PROBES, Some(&photo), &[]).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(
        body,
        json!({"code":"too_many_requests", "error":"rate limit exceeded"})
    );
    let retry: u64 = headers["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=60).contains(&retry));
    Contract::load().assert_conforms(PROBES, "post", status, &body);
    let other_user = common::clerk::user();
    sqlx::query(
        "INSERT INTO members (store_id, display_name, role, clerk_user_id) VALUES ($1, 'Seller', 'seller', $2)",
    )
    .bind(store_id)
    .bind(&other_user)
    .execute(state.postgres.as_ref().unwrap())
    .await
    .unwrap();
    let other_token = common::clerk::clerk_token(&other_user, "sess_probe_seller");
    let (status, body, _) = post_recognition(&app, &other_token, PROBES, Some(&photo), &[]).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a seller in the same store has its own limit: {body}"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn document_probe_works_while_scan_slots_are_exhausted() {
    let state = probe_state(true).await;
    let app = router(state.clone());
    let (_, _, token) = create_store(&app).await;
    let _permit = state.inference_slots.clone().acquire_owned().await.unwrap();
    let (status, body, headers) =
        post_recognition(&app, &token, PROBES, Some(&draw_photo()), &[]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["detected"], true);
    assert_eq!(body["text_lines"], 6);
    assert!(!headers.contains_key("retry-after"));
    Contract::load().assert_conforms(PROBES, "post", status, &body);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn document_probe_pool_full_returns_empty_signal() {
    let state = probe_state(true).await;
    let app = router(state.clone());
    let (_, _, token) = create_store(&app).await;
    let permit = state.probe_slots.clone().acquire_owned().await.unwrap();
    let photo = draw_photo();
    let (status, body, headers) = post_recognition(&app, &token, PROBES, Some(&photo), &[]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({"detected":false,"score":0.,"text_lines":0,"line_boxes":[]})
    );
    assert!(!headers.contains_key("retry-after"));
    Contract::load().assert_conforms(PROBES, "post", status, &body);
    assert_eq!(state.inference_slots.available_permits(), 1);
    drop(permit);
    let (status, body, _) = post_recognition(&app, &token, PROBES, Some(&photo), &[]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["detected"], true,
        "pool resumes detection after release"
    );
}

#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn scan_works_while_probe_holds_its_slot() {
    use std::sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use taphoa_recognition::ocr::{OcrError, TextBox, TextDetector};
    struct BlockingFirstDetection {
        first: AtomicBool,
        started: Arc<tokio::sync::Notify>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }
    impl TextDetector for BlockingFirstDetection {
        fn detect(&self, _: &[u8]) -> Result<Vec<TextBox>, OcrError> {
            if self.first.swap(false, Ordering::SeqCst) {
                self.started.notify_one();
                let (lock, changed) = &*self.release;
                let _guard = changed
                    .wait_timeout_while(
                        lock.lock().unwrap(),
                        std::time::Duration::from_secs(5),
                        |released| !*released,
                    )
                    .unwrap();
            }
            Ok(vec![])
        }
    }
    let (_, mut state, _) = build_state(scan_segments())
        .await
        .expect("test services configured");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    state.text_detector = Some(Arc::new(BlockingFirstDetection {
        first: AtomicBool::new(true),
        started: started.clone(),
        release: release.clone(),
    }));
    let app = router(state.clone());
    let (_, _, token) = create_store(&app).await;
    let probe = tokio::spawn({
        let app = app.clone();
        let token = token.clone();
        async move { post_recognition(&app, &token, PROBES, Some(&draw_photo()), &[]).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .expect("probe entered its blocking detector");
    assert_eq!(state.probe_slots.available_permits(), 0);
    assert_eq!(state.inference_slots.available_permits(), 1);
    let scan = post_scan(&app, &token, Some(&draw_photo()), &[]).await;
    let probe_permits_during_scan = state.probe_slots.available_permits();
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    let (probe_status, probe_body, _) = probe.await.unwrap();
    assert_eq!(probe_status, StatusCode::OK, "{probe_body}");
    assert_eq!(probe_permits_during_scan, 0, "probe was still running");
    let (status, body, _) = scan;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    Contract::load().assert_conforms("/v1/recognition/scans", "post", status, &body);
    assert_eq!(state.probe_slots.available_permits(), 1);
}

/// A detector that cannot finish until after the response proves checkout does not
/// await an arbitrarily slow detector. Its admission permit must remain held.
#[tokio::test]
#[ignore = "real services required; DATABASE_URL, REDIS_URL and all AWS_* storage variables"]
async fn slow_detector_times_out_without_releasing_inference_admission() {
    use std::sync::{Condvar, Mutex};
    use taphoa_recognition::ocr::{DocumentSignal, OcrError, TextBox, TextDetector};
    struct StalledDetector(Arc<(Mutex<bool>, Condvar)>);
    impl TextDetector for StalledDetector {
        fn detect(&self, _: &[u8]) -> Result<Vec<TextBox>, OcrError> {
            Ok(vec![])
        }
        fn document_signal(&self, _: &[u8]) -> Result<DocumentSignal, OcrError> {
            let (lock, changed) = &*self.0;
            let guard = lock.lock().unwrap();
            let _guard = changed
                .wait_timeout_while(guard, std::time::Duration::from_secs(3), |released| {
                    !*released
                })
                .unwrap();
            Ok(DocumentSignal {
                detected: true,
                score: 1.,
                text_lines: 8,
                line_boxes: vec![],
            })
        }
    }
    let (_, mut state, _) = build_state(scan_segments())
        .await
        .expect("test services configured");
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    state.text_detector = Some(Arc::new(StalledDetector(release.clone())));
    let app = router(state.clone());
    let (_, _, token) = create_store(&app).await;
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        post_scan(&app, &token, Some(&draw_photo()), &[]),
    )
    .await;
    let permits_before_release = state.inference_slots.available_permits();
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    let (status, body, _) = response.expect("scan should return while detector is stalled");
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["document"],
        json!({"detected":false,"score":0.0,"text_lines":0,"line_boxes":[]})
    );
    assert_eq!(
        permits_before_release, 0,
        "blocking detector still owns admission"
    );
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while state.inference_slots.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
