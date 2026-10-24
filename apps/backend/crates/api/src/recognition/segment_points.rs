//! Handler for `POST /v1/segment/points` with encoder cache.

use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor},
    error::ValidJson,
    images::ImageRow,
    recognition::service::CROP_PADDING,
};
use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use image::RgbImage;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};
use taphoa_recognition::{PointPrompt, SegmentError};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct SegmentPointsRequest {
    pub image_id: Uuid,
    pub points: Vec<PointPromptInput>,
}

#[derive(Debug, Deserialize)]
pub struct PointPromptInput {
    pub x: f32,
    pub y: f32,
    pub label: u8,
}

#[derive(Debug, Serialize)]
pub struct SegmentPointsResponse {
    pub bbox: [f32; 4],
    pub score: f32,
    pub area: u32,
    pub mask: MaskDisplay,
    pub cutout_image_id: Uuid,
    pub timings: SegmentPointsTimings,
}

#[derive(Debug, Serialize)]
pub struct MaskDisplay {
    pub width: u32,
    pub height: u32,
    pub png_base64: String,
}

#[derive(Debug, Serialize)]
pub struct SegmentPointsTimings {
    pub encode: u64,
    pub decode: u64,
    pub total: u64,
}

fn busy() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "segmenter busy",
    )
    .with_retry_after(1)
}

fn no_model() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "no model loaded",
    )
}

fn unavailable(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", msg)
}

fn storage_failure(e: anyhow::Error) -> ApiError {
    tracing::error!(%e, "storage failure");
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "storage_failure",
        "storage failure",
    )
}

fn database_failure(e: sqlx::Error) -> ApiError {
    tracing::error!(%e, "database failure");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "database failure",
    )
}

fn task_failure(e: tokio::task::JoinError) -> ApiError {
    tracing::error!(%e, "blocking task failed");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "inference task failed",
    )
}

fn inference_failure(e: SegmentError) -> ApiError {
    match e {
        SegmentError::InvalidPrompt(msg) => {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", msg)
        }
        SegmentError::InvalidImage(msg) => {
            ApiError::new(StatusCode::BAD_REQUEST, "validation_failed", msg)
        }
        other => {
            tracing::error!(%other, "inference failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                other.to_string(),
            )
        }
    }
}

fn decode_rgb(bytes: &[u8]) -> Result<RgbImage, ApiError> {
    taphoa_recognition::crop::decode_limited(bytes)
        .map(|img| img.to_rgb8())
        .map_err(|e| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "validation_failed",
                format!("could not decode image: {e}"),
            )
        })
}

fn object_key(extension: &str) -> String {
    format!(
        "{}/{}.{}",
        Utc::now().format("%Y%m%d"),
        Uuid::new_v4(),
        extension
    )
}

/// Handler for `POST /v1/segment/points`.
pub async fn segment_points(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(request): ValidJson<SegmentPointsRequest>,
) -> ApiResult<Json<SegmentPointsResponse>> {
    let wall = Instant::now();

    // Permission check: Lead or seller with can_enroll
    actor.require(Action::EnrollProduct)?;

    // Early validation of points count and labels before storage or inference
    if request.points.is_empty() || request.points.len() > 2 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            format!("expected 1 or 2 points, got {}", request.points.len()),
        ));
    }
    for p in &request.points {
        if p.label > 1 {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_failed",
                format!("label must be 0 or 1, got {}", p.label),
            ));
        }
        if !p.x.is_finite() || !p.y.is_finite() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_failed",
                "coordinates must be finite",
            ));
        }
    }
    if !request.points.iter().any(|p| p.label == 1) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "at least one foreground point (label 1) required",
        ));
    }

    let point_segmenter = state
        .point_segmenter
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(no_model)?;

    let storage = state
        .storage
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| unavailable("storage not configured"))?;

    let repository = state
        .image_repository
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| unavailable("image repository not configured"))?;

    // Image lookup in DB (must belong to this store)
    let row = repository
        .get(request.image_id, actor.store_id)
        .await
        .map_err(database_failure)?
        .ok_or_else(ApiError::not_found)?;

    // Cache lookup or encode
    let (encoding, photo, encode_ms) = if let Some((cached_enc, cached_photo)) =
        state.segment_cache.get(actor.store_id, request.image_id)
    {
        let photo = match cached_photo {
            Some(p) => p,
            None => {
                let bytes = storage
                    .get(&row.object_key)
                    .await
                    .map_err(storage_failure)?;
                Arc::new(decode_rgb(&bytes)?)
            }
        };
        (cached_enc, photo, 0u64)
    } else {
        let bytes = storage
            .get(&row.object_key)
            .await
            .map_err(storage_failure)?;
        let photo = Arc::new(decode_rgb(&bytes)?);

        let permit = state
            .inference_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;

        let start_encode = Instant::now();
        let seg = Arc::clone(&point_segmenter);
        let bytes_clone = bytes.clone();
        let encoding = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            seg.encode(&bytes_clone)
        })
        .await
        .map_err(task_failure)?
        .map_err(inference_failure)?;
        let encode_ms = start_encode.elapsed().as_millis() as u64;

        state.segment_cache.insert(
            actor.store_id,
            request.image_id,
            Arc::clone(&encoding),
            Some(Arc::clone(&photo)),
        );

        (encoding, photo, encode_ms)
    };

    // Validate points against photo dimensions in encoding
    let prompts: Vec<PointPrompt> = request
        .points
        .iter()
        .map(|p| PointPrompt {
            x: p.x,
            y: p.y,
            label: p.label,
        })
        .collect();

    taphoa_recognition::validate_points(&prompts, encoding.width, encoding.height).map_err(
        |e| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_failed",
                e.to_string(),
            )
        },
    )?;

    // Run decode_points with an inference slot permit
    let permit = state
        .inference_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;

    let start_decode = Instant::now();
    let seg = Arc::clone(&point_segmenter);
    let enc = Arc::clone(&encoding);
    let pts = prompts.clone();
    let point_segment = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        seg.decode_points(&enc, &pts)
    })
    .await
    .map_err(task_failure)?
    .map_err(inference_failure)?;
    let decode_ms = start_decode.elapsed().as_millis() as u64;

    // Build cutout crop
    let cutout_img = taphoa_recognition::crop::cutout(
        &photo,
        &point_segment.mask,
        point_segment.segment.bbox,
        CROP_PADDING,
    )
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "could not generate cutout",
        )
    })?;

    // Encode cutout as JPEG
    let mut cutout_bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cutout_bytes, 85);
    encoder.encode_image(&cutout_img).map_err(|e| {
        tracing::error!(%e, "cutout jpeg encoding failed");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "cutout encoding failed",
        )
    })?;

    // Store cutout image in object storage and images table
    let cutout_row = ImageRow {
        id: Uuid::new_v4(),
        object_key: object_key("jpg"),
        content_type: "image/jpeg".into(),
        byte_size: cutout_bytes.len() as i64,
        purpose: "crop".into(),
    };

    storage
        .put(&cutout_row.object_key, "image/jpeg", cutout_bytes)
        .await
        .map_err(storage_failure)?;

    if let Err(error) = repository.insert(&cutout_row, &actor).await {
        if let Err(cleanup) = storage.delete(&cutout_row.object_key).await {
            tracing::error!(%cleanup, "failed to delete cutout object after DB insert error");
        }
        return Err(database_failure(error));
    }

    // Encode mask as PNG bytes and standard base64
    let mut png_bytes = Vec::new();
    point_segment
        .mask
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| {
            tracing::error!(%e, "mask png encoding failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "mask encoding failed",
            )
        })?;
    let png_base64 = STANDARD.encode(&png_bytes);

    let total_ms = wall.elapsed().as_millis() as u64;

    Ok(Json(SegmentPointsResponse {
        bbox: point_segment.segment.bbox,
        score: point_segment.segment.score,
        area: point_segment.segment.area,
        mask: MaskDisplay {
            width: point_segment.mask.width(),
            height: point_segment.mask.height(),
            png_base64,
        },
        cutout_image_id: cutout_row.id,
        timings: SegmentPointsTimings {
            encode: encode_ms,
            decode: decode_ms,
            total: total_ms,
        },
    }))
}
