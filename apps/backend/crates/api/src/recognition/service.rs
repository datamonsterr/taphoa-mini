//! Scan pipeline: blocking segmentation/embedding work, candidate lookups,
//! persistence and response rendering. Handlers stay thin; nothing here may
//! block the async runtime or add per-detection database round trips.
use crate::{
    ApiError,
    auth::Actor,
    images::ImageRow,
    recognition::classify::{self, DedupeKey, MatchClass},
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use image::{RgbImage, imageops::FilterType};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use std::{collections::HashMap, time::Duration};
use taphoa_recognition::{Embedder, Segment, Segmenter};
use uuid::Uuid;

/// Public segmenter id recorded on scans while phase one runs MobileSAM.
pub(crate) const SCAN_SEGMENTER: &str = "mobilesam-onnx@1";
/// Remaining fraction of every crop edge grown before embedding (architecture 5.3).
pub(crate) const CROP_PADDING: f32 = 0.08;
const THUMBNAIL_QUALITY: u8 = 80;
const THUMBNAIL_MAX_SIDE: u32 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScanMode {
    Single,
    Multi,
}
impl ScanMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Multi => "multi",
        }
    }
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "single" => Some(Self::Single),
            "multi" => Some(Self::Multi),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScanPurpose {
    Checkout,
    Enrollment,
}
impl ScanPurpose {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Checkout => "checkout",
            Self::Enrollment => "enrollment",
        }
    }
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "checkout" => Some(Self::Checkout),
            "enrollment" => Some(Self::Enrollment),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum StageError {
    #[error("invalid image: {0}")]
    InvalidImage(String),
    #[error("inference failed: {0}")]
    Inference(String),
}

pub(crate) struct BlockedDetection {
    pub bbox: [f32; 4],
    pub score: f32,
    pub area: u32,
    pub embedding: Vec<f32>,
    pub thumbnail: Vec<u8>,
}

pub(crate) struct BlockingResult {
    pub detections: Vec<BlockedDetection>,
    pub segment_ms: f64,
    pub embed_ms: f64,
}

/// Runs on the blocking thread pool while the inference permit is held:
/// segment, crop every box with padding, embed all crops in one call and
/// encode the crop thumbnails.
pub(crate) fn block_pipeline(
    segmenter: &dyn Segmenter,
    embedder: &dyn Embedder,
    image_bytes: &[u8],
    mode: ScanMode,
    max_detections: usize,
) -> Result<BlockingResult, StageError> {
    let started = std::time::Instant::now();
    let decoded = decode_rgb(image_bytes)?;
    let segments = segmenter
        .segment(image_bytes)
        .map_err(|error| match error {
            taphoa_recognition::SegmentError::InvalidImage(_) => {
                StageError::InvalidImage(error.to_string())
            }
            other => StageError::Inference(other.to_string()),
        })?;
    let segment_ms = started.elapsed().as_secs_f64() * 1000.0;
    let chosen = match mode {
        ScanMode::Multi => {
            let mut segments = segments;
            // Keep the strongest boxes when the segmenter reports more than we accept.
            segments.sort_by(|a, b| b.score.total_cmp(&a.score));
            segments.truncate(max_detections);
            segments
        }
        ScanMode::Single => {
            let (width, height) = (decoded.width(), decoded.height());
            vec![
                classify::pick_single(&segments, width, height)
                    .unwrap_or_else(|| classify::whole_image_box(width, height)),
            ]
        }
    };
    let started_embed = std::time::Instant::now();
    let mut picks = Vec::with_capacity(chosen.len());
    for segment in chosen {
        let Some(crop) =
            taphoa_recognition::crop::crop_with_padding(&decoded, segment.bbox, CROP_PADDING)
        else {
            continue;
        };
        picks.push((segment, crop));
    }
    let thumbnails: Result<Vec<Vec<u8>>, StageError> = picks
        .iter()
        .map(|(.., crop)| encode_thumbnail(crop).map_err(|e| StageError::Inference(e.to_string())))
        .collect();
    let thumbnails = thumbnails?;
    // One embedding call for all crops; ownership moves instead of copying.
    let (segments, crops): (Vec<Segment>, Vec<RgbImage>) = picks.into_iter().unzip();
    let vectors: Vec<Vec<f32>> = embedder
        .embed_crops(&crops)
        .map_err(|error| StageError::Inference(error.to_string()))?;
    if vectors.len() != segments.len() {
        return Err(StageError::Inference("incomplete crop embeddings".into()));
    }
    drop(crops);
    let embed_ms = started_embed.elapsed().as_secs_f64() * 1000.0;
    Ok(BlockingResult {
        detections: std::iter::zip(segments, std::iter::zip(vectors, thumbnails))
            .map(|(segment, (embedding, thumbnail))| BlockedDetection {
                bbox: segment.bbox,
                score: segment.score,
                area: segment.area,
                embedding,
                thumbnail,
            })
            .collect(),
        segment_ms,
        embed_ms,
    })
}

/// Decodes the original photo within the same limits segmentation uses.
fn decode_rgb(bytes: &[u8]) -> Result<RgbImage, StageError> {
    taphoa_recognition::crop::decode_limited(bytes)
        .map(|image| image.to_rgb8())
        .map_err(StageError::InvalidImage)
}

/// JPEG quality 80, longest side at most 256 (architecture 5.3).
pub(crate) fn encode_thumbnail(crop: &RgbImage) -> Result<Vec<u8>, image::ImageError> {
    let long_side = crop.width().max(crop.height());
    let thumbnail = if long_side > THUMBNAIL_MAX_SIDE {
        let scale = f64::from(THUMBNAIL_MAX_SIDE) / f64::from(long_side);
        image::imageops::resize(
            crop,
            (f64::from(crop.width()) * scale).round().max(1.0) as u32,
            (f64::from(crop.height()) * scale).round().max(1.0) as u32,
            FilterType::Triangle,
        )
    } else {
        image::imageops::resize(crop, crop.width(), crop.height(), FilterType::Triangle)
    };
    let mut bytes = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, THUMBNAIL_QUALITY);
    encoder.encode_image(&thumbnail)?;
    Ok(bytes)
}

/// The pipeline stores raw product references; the API never stores URLs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateSnapshot {
    pub product_id: Uuid,
    pub similarity: f32,
    pub name: Option<String>,
    pub price: i64,
    pub default_unit_id: Option<Uuid>,
}

/// Snapshot plus the presigning inputs captured at scan time.
#[derive(Debug, Clone)]
pub(crate) struct CandidateDisplay {
    pub snapshot: CandidateSnapshot,
    pub thumbnail_key: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RatedDetection {
    pub bbox: [f32; 4],
    pub score: f32,
    pub area: u32,
    pub embedding: Vec<f32>,
    pub thumbnail: Vec<u8>,
    pub class: MatchClass,
    pub candidates: Vec<CandidateDisplay>,
}

pub(crate) struct ProductInfo {
    pub name: Option<String>,
    pub price: i64,
    pub unit_id: Option<Uuid>,
    pub thumbnail_key: Option<String>,
}

/// One query for every candidate product: name, price, smallest sellable unit
/// and the primary image object key (data-model 3.3).
pub(crate) async fn product_metadata(
    pool: &PgPool,
    store_id: Uuid,
    product_ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, ProductInfo>, sqlx::Error> {
    if product_ids.is_empty() {
        return Ok(HashMap::new());
    }
    type ProductRow = (
        Uuid,
        Option<String>,
        i64,
        Option<Uuid>,
        Option<Uuid>,
        Option<String>,
    );
    let rows: Vec<ProductRow> = sqlx::query_as(
        "SELECT p.id, p.name, p.price, u.unit_id, primary_image.image_id, i.object_key \
         FROM products p \
         LEFT JOIN LATERAL (SELECT pu.id AS unit_id FROM product_units pu \
             WHERE pu.product_id = p.id ORDER BY pu.quantity_in_base LIMIT 1) u ON true \
         LEFT JOIN LATERAL (SELECT pi.image_id FROM product_images pi \
             WHERE pi.product_id = p.id ORDER BY pi.position LIMIT 1) primary_image ON true \
         LEFT JOIN images i ON i.id = primary_image.image_id \
         WHERE p.store_id = $1 AND NOT p.archived AND p.id = ANY($2)",
    )
    .bind(store_id)
    .bind(product_ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, price, unit_id, _, thumbnail_key)| {
            (
                id,
                ProductInfo {
                    name,
                    price,
                    unit_id,
                    thumbnail_key,
                },
            )
        })
        .collect())
}

pub(crate) fn candidate_displays(
    hits: &[crate::vector::VectorHit],
    products: &HashMap<Uuid, ProductInfo>,
) -> Vec<CandidateDisplay> {
    hits.iter()
        .filter_map(|hit| {
            let info = products.get(&hit.product_id)?;
            Some(CandidateDisplay {
                snapshot: CandidateSnapshot {
                    product_id: hit.product_id,
                    similarity: hit.similarity,
                    name: info.name.clone(),
                    price: info.price,
                    default_unit_id: info.unit_id,
                },
                thumbnail_key: info.thumbnail_key.clone(),
            })
        })
        .collect()
}

/// `{segment, embed, search, total}` in rounded milliseconds.
pub(crate) fn timings_value(
    segment_ms: f64,
    embed_ms: f64,
    search_ms: f64,
    total_ms: f64,
) -> serde_json::Value {
    let ms = |value: f64| value.max(0.0).round() as i64;
    json!({"segment": ms(segment_ms), "embed": ms(embed_ms), "search": ms(search_ms), "total": ms(total_ms)})
}

/// Keeps the strongest repeated-product crops and reorders for display.
pub(crate) fn arrange_display_order(mut rated: Vec<RatedDetection>) -> Vec<RatedDetection> {
    rated = classify::dedupe(rated, |detection| DedupeKey {
        score: detection.score,
        bbox: detection.bbox,
        top_product: detection.candidates.first().map(|c| c.snapshot.product_id),
        class: detection.class,
    });
    let boxes: Vec<[f32; 4]> = rated.iter().map(|d| d.bbox).collect();
    classify::order_row_major(&boxes)
        .into_iter()
        .map(|index| rated[index].clone())
        .collect()
}

/// Everything a rendered scan response needs.
pub(crate) struct ScanDisplay {
    pub id: Uuid,
    // Kept alongside the other render inputs so callers cannot mix stores.
    #[allow(dead_code)]
    pub store_id: Uuid,
    pub original: ImageRow,
    pub mode: ScanMode,
    pub purpose: ScanPurpose,
    pub segmenter: String,
    pub embedder: String,
    pub catalog_version: i64,
    pub timings_ms: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub detections: Vec<DetectionDisplay>,
}

#[derive(Debug, Clone)]
pub(crate) struct DetectionDisplay {
    pub id: Uuid,
    pub bbox: [f32; 4],
    pub score: f32,
    pub crop_key: Option<String>,
    pub class: MatchClass,
    pub candidates: Vec<CandidateDisplay>,
}

pub(crate) fn no_document() -> taphoa_recognition::ocr::DocumentSignal {
    taphoa_recognition::ocr::DocumentSignal {
        detected: false,
        score: 0.,
        text_lines: 0,
    }
}

#[derive(Serialize)]
pub(crate) struct ScanResponse {
    id: Uuid,
    image: ImageJson,
    mode: ScanMode,
    purpose: ScanPurpose,
    pipeline: PipelineJson,
    timings_ms: serde_json::Value,
    document: taphoa_recognition::ocr::DocumentSignal,
    pub(crate) detections: Vec<DetectionJson>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct ImageJson {
    id: Uuid,
    object_key: String,
    content_type: String,
    byte_size: i64,
    purpose: String,
    url: String,
    url_expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct PipelineJson {
    segmenter: String,
    embedder: String,
    catalog_version: i64,
}

#[derive(Serialize)]
pub(crate) struct DetectionJson {
    id: Uuid,
    bbox: [f32; 4],
    score: f32,
    crop_url: Option<String>,
    #[serde(rename = "match")]
    match_class: MatchClass,
    candidates: Vec<CandidateJson>,
}

#[derive(Serialize)]
struct CandidateJson {
    product_id: Uuid,
    similarity: f32,
    name: Option<String>,
    price: i64,
    default_unit_id: Option<Uuid>,
    /// Absent when the product has no primary image; never drifted from
    /// `CandidateSnapshot` (presigning happens at read time).
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url: Option<String>,
}

pub(crate) fn storage_failure(error: anyhow::Error) -> ApiError {
    tracing::error!(%error, "object storage operation failed");
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "storage_failure",
        "storage failure",
    )
}

/// A stored candidate snapshot that no longer deserializes (not a sqlx error).
fn stored_snapshot_failure(error: serde_json::Error) -> ApiError {
    tracing::error!(%error, "recognition database operation failed");
    ApiError::internal()
}

pub(crate) fn database_failure(error: sqlx::Error) -> ApiError {
    crate::error::log_sqlx_error!(error, &error, "recognition database operation failed");
    ApiError::internal()
}

/// Presigns all images and maps every display into the contract JSON.
pub(crate) async fn render_scan(
    storage: &dyn crate::storage::ObjectStore,
    ttl: Duration,
    mut scan: ScanDisplay,
) -> Result<ScanResponse, ApiError> {
    let signed = |key: String| async move {
        storage
            .presign_get(&key, ttl)
            .await
            .map_err(storage_failure)
    };
    let original_url = signed(scan.original.object_key.clone()).await?;
    let mut answer = Vec::with_capacity(scan.detections.len());
    for detection in scan.detections {
        let crop_url = match &detection.crop_key {
            Some(key) => Some(signed(key.clone()).await?.url),
            None => None,
        };
        let mut candidates = Vec::with_capacity(detection.candidates.len());
        for candidate in detection.candidates {
            let thumbnail_url = match &candidate.thumbnail_key {
                Some(key) => Some(signed(key.clone()).await?.url),
                None => None,
            };
            candidates.push(CandidateJson {
                product_id: candidate.snapshot.product_id,
                similarity: candidate.snapshot.similarity,
                name: candidate.snapshot.name,
                price: candidate.snapshot.price,
                default_unit_id: candidate.snapshot.default_unit_id,
                thumbnail_url,
            });
        }
        answer.push(DetectionJson {
            id: detection.id,
            bbox: detection.bbox,
            score: detection.score,
            crop_url,
            match_class: detection.class,
            candidates,
        });
    }
    let document = scan
        .timings_ms
        .as_object_mut()
        .and_then(|timings| timings.remove("document"))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_else(no_document);
    Ok(ScanResponse {
        id: scan.id,
        image: ImageJson {
            id: scan.original.id,
            object_key: scan.original.object_key,
            content_type: scan.original.content_type,
            byte_size: scan.original.byte_size,
            purpose: scan.original.purpose,
            url: original_url.url,
            url_expires_at: original_url.expires_at,
        },
        mode: scan.mode,
        purpose: scan.purpose,
        pipeline: PipelineJson {
            segmenter: scan.segmenter,
            embedder: scan.embedder,
            catalog_version: scan.catalog_version,
        },
        timings_ms: scan.timings_ms,
        document,
        detections: answer,
        created_at: scan.created_at,
    })
}

/// Persists thumbnail `images` rows, the scan and all detections atomically.
/// Crop bytes were already written to the bucket; keys come prepared.
pub(crate) struct PersistDetection {
    pub id: Uuid,
    pub bbox: [f32; 4],
    pub score: f32,
    pub area: u32,
    pub crop_key: String,
    pub thumbnail_bytes: usize,
    pub embedding: Vec<f32>,
    pub class: MatchClass,
    pub candidates: Vec<CandidateSnapshot>,
}

/// Scan insert payload (identity fields and scan timing snapshot).
pub(crate) struct ScanDraft {
    pub image_id: Uuid,
    pub mode: ScanMode,
    pub purpose: ScanPurpose,
    pub embedder_model: String,
    pub wall_time_ms: u64,
    pub timings_ms: serde_json::Value,
}

/// Returns `(scan id, created_at, catalog_version)`.
pub(crate) async fn persist_scan(
    pool: &PgPool,
    actor: &Actor,
    draft: ScanDraft,
    detections: &[PersistDetection],
) -> Result<(Uuid, DateTime<Utc>, i64), sqlx::Error> {
    let ScanDraft {
        image_id,
        mode,
        purpose,
        embedder_model,
        wall_time_ms,
        timings_ms,
    } = draft;
    let mut tx = pool.begin().await?;
    let mut crop_ids = Vec::with_capacity(detections.len());
    for detection in detections {
        // Detached thumbnail row: the bucket object was written before this
        // transaction and is cleaned up when the transaction aborts.
        let crop_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO images (id, store_id, object_key, content_type, byte_size, purpose, uploaded_by) \
             VALUES ($1, $2, $3, 'image/jpeg', $4, 'crop', $5)",
        )
        .bind(crop_id)
        .bind(actor.store_id)
        .bind(&detection.crop_key)
        .bind(detection.thumbnail_bytes as i64)
        .bind(actor.member_id)
        .execute(&mut *tx)
        .await?;
        crop_ids.push(crop_id);
    }
    let (scan_id, created_at, catalog_version): (Uuid, DateTime<Utc>, i64) = sqlx::query_as(
        "INSERT INTO scans (store_id, image_id, member_id, mode, purpose, segmenter, embedder, catalog_version, timings) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, \
             (SELECT COALESCE(max(seq), 0) FROM change_log WHERE store_id = $1), $8) \
         RETURNING id, created_at, catalog_version",
    )
    .bind(actor.store_id)
    .bind(image_id)
    .bind(actor.member_id)
    .bind(mode.as_str())
    .bind(purpose.as_str())
    .bind(SCAN_SEGMENTER)
    .bind(&embedder_model)
    .bind(&timings_ms)
    .fetch_one(&mut *tx)
    .await?;
    write_detections(&mut tx, actor, scan_id, detections, &crop_ids).await?;
    let match_class = detections.first().map_or(MatchClass::Unknown, |d| d.class);
    let latency_ms = timings_ms["total"].as_u64().unwrap_or(wall_time_ms);
    crate::events::emit(&mut tx, crate::events::Event { store_id:actor.store_id, actor:Some((actor.member_id,actor.session_id)),typ:"scan.completed",version:1,data:json!({"scan_id":scan_id,"mode":mode.as_str(),"detections":detections.len(),"timings":timings_ms,"model":embedder_model,"purpose":purpose.as_str(),"match_class":match_class,"latency_ms":latency_ms}),change:None }).await?;
    tx.commit().await?;
    Ok((scan_id, created_at, catalog_version))
}

async fn write_detections(
    tx: &mut sqlx::PgConnection,
    actor: &Actor,
    scan_id: Uuid,
    detections: &[PersistDetection],
    crop_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    for (position, (detection, crop_id)) in detections.iter().zip(crop_ids).enumerate() {
        // Column is `vector(384)`; other adapters still scan without persistence.
        let embedding =
            (detection.embedding.len() == 384).then(|| embedding_literal(&detection.embedding));
        sqlx::query(
            "INSERT INTO detections (id, store_id, scan_id, position, bbox, score, area, crop_image_id, embedding, match, candidates) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::vector, $10, $11)",
        )
        .bind(detection.id)
        .bind(actor.store_id)
        .bind(scan_id)
        .bind(position as i16)
        .bind(detection.bbox.to_vec())
        .bind(detection.score)
        .bind(detection.area.min(i32::MAX as u32) as i32)
        .bind(crop_id)
        .bind(embedding)
        .bind(detection.class.to_string())
        .bind(serde_json::to_value(&detection.candidates).unwrap_or_else(|_| json!([])))
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

fn embedding_literal(embedding: &[f32]) -> String {
    let mut text = String::with_capacity(embedding.len() * 12 + 2);
    text.push('[');
    for (index, value) in embedding.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        text.push_str(&value.to_string());
    }
    text.push(']');
    text
}

/// One scan row of the actor's store, or `None` to keep ownership invisible.
pub(crate) struct ScanRow {
    pub image_id: Uuid,
    pub mode: ScanMode,
    pub purpose: ScanPurpose,
    pub segmenter: String,
    pub embedder: String,
    pub catalog_version: i64,
    pub timings_ms: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

pub(crate) async fn load_scan(
    pool: &PgPool,
    scan_id: Uuid,
    store_id: Uuid,
) -> Result<Option<ScanRow>, ApiError> {
    type ScanRowTuple = (
        Uuid,
        String,
        String,
        String,
        String,
        i64,
        serde_json::Value,
        DateTime<Utc>,
    );
    let row: Option<ScanRowTuple> = sqlx::query_as(
        "SELECT image_id, mode, purpose, segmenter, embedder, catalog_version, timings, created_at \
             FROM scans WHERE id = $1 AND store_id = $2",
    )
    .bind(scan_id)
    .bind(store_id)
    .fetch_optional(pool)
    .await
    .map_err(database_failure)?;
    let Some((
        image_id,
        mode,
        purpose,
        segmenter,
        embedder,
        catalog_version,
        timings_ms,
        created_at,
    )) = row
    else {
        return Ok(None);
    };
    let mode = ScanMode::parse(&mode).ok_or_else(ApiError::internal)?;
    let purpose = ScanPurpose::parse(&purpose).ok_or_else(ApiError::internal)?;
    Ok(Some(ScanRow {
        image_id,
        mode,
        purpose,
        segmenter,
        embedder,
        catalog_version,
        timings_ms,
        created_at,
    }))
}

/// A persisted detection row joined with the crop object key.
pub(crate) struct StoredDetection {
    pub id: Uuid,
    pub bbox: Vec<f32>,
    pub score: f32,
    pub crop_key: Option<String>,
    pub class: MatchClass,
    pub candidates: Vec<CandidateSnapshot>,
}

pub(crate) async fn load_detections(
    pool: &PgPool,
    scan_id: Uuid,
) -> Result<Vec<StoredDetection>, ApiError> {
    type DetectionRow = (
        Uuid,
        Vec<f32>,
        f32,
        Option<String>,
        String,
        serde_json::Value,
    );
    let rows: Vec<DetectionRow> = sqlx::query_as(
        "SELECT d.id, d.bbox, d.score, i.object_key, d.match, d.candidates \
         FROM detections d LEFT JOIN images i ON i.id = d.crop_image_id \
         WHERE d.scan_id = $1 ORDER BY d.position",
    )
    .bind(scan_id)
    .fetch_all(pool)
    .await
    .map_err(database_failure)?;
    rows.into_iter()
        .map(|(id, bbox, score, crop_key, class, candidates)| {
            let class = to_class(&class)?;
            let mut snapshots = Vec::new();
            for candidate in candidates.as_array().map(Vec::as_slice).unwrap_or(&[]) {
                snapshots.push(
                    serde_json::from_value::<CandidateSnapshot>(candidate.clone())
                        .map_err(stored_snapshot_failure)?,
                );
            }
            Ok(StoredDetection {
                id,
                bbox,
                score,
                crop_key,
                class,
                candidates: snapshots,
            })
        })
        .collect()
}

pub(crate) fn to_class(value: &str) -> Result<MatchClass, ApiError> {
    match value {
        "matched" => Ok(MatchClass::Matched),
        "ambiguous" => Ok(MatchClass::Ambiguous),
        "unknown" => Ok(MatchClass::Unknown),
        _ => Err(ApiError::internal()),
    }
}
