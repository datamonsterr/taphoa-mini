//! Recognition scan endpoints: `POST /v1/recognition/scans` and
//! `GET /v1/recognition/scans/{scanId}` (architecture 5.3, contract createScan
//! and getScan).
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Actor, permissions::Action},
    bad_request, busy,
    images::{ImageRow, MAX_IMAGE_REQUEST_BYTES},
    multipart_error, no_model,
    recognition::{classify, service as pipeline, service::CandidateDisplay},
    storage::ObjectStore,
    vector::VectorHit,
};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Multipart, Path, State,
        multipart::{Field, MultipartRejection},
    },
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use futures_util::future::join_all;
use std::{sync::Arc, time::Instant};
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/recognition/scans",
            post(create_scan)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(
                    MAX_IMAGE_REQUEST_BYTES,
                ))
                .layer(RequestBodyLimitLayer::new(MAX_IMAGE_REQUEST_BYTES)),
        )
        .route("/v1/recognition/scans/{scanId}", get(get_scan))
}

struct ScanRequest {
    image: Option<Vec<u8>>,
    image_id: Option<Uuid>,
    mode: pipeline::ScanMode,
    purpose: pipeline::ScanPurpose,
    top_k: u8,
}

/// Field order rules: the inference slot is taken by the caller before the
/// body here is read; exactly one of `image` or `image_id` is required.
async fn parse_request(multipart: Result<Multipart, MultipartRejection>) -> ApiResult<ScanRequest> {
    let mut multipart = multipart.map_err(|_| bad_request())?;
    let mut image: Option<Vec<u8>> = None;
    let mut image_id: Option<Uuid> = None;
    let mut mode = None;
    let mut purpose = None;
    let mut top_k = None;
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("image") if image.is_none() && image_id.is_none() => {
                let declared = field.content_type().map(str::to_owned);
                if let Some(value) = &declared
                    && !matches!(
                        declared_mime(value).as_deref(),
                        Some("image/jpeg" | "image/png")
                    )
                {
                    return Err(unsupported_media_type());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_REQUEST_BYTES {
                        return Err(ApiError::new(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "payload_too_large",
                            "image upload too large",
                        ));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if bytes.is_empty() {
                    return Err(bad_request());
                }
                image = Some(bytes);
            }
            Some("image_id") if image_id.is_none() && image.is_none() => {
                image_id = Some(
                    read_text(&mut field, 64)
                        .await?
                        .parse()
                        .map_err(|_| ApiError::validation_failed("image_id must be a UUID"))?,
                );
            }
            Some("mode") if mode.is_none() => {
                mode = Some(
                    pipeline::ScanMode::parse(&read_text(&mut field, 16).await?)
                        .ok_or_else(bad_request)?,
                );
            }
            Some("purpose") if purpose.is_none() => {
                purpose = Some(
                    pipeline::ScanPurpose::parse(&read_text(&mut field, 16).await?)
                        .ok_or_else(bad_request)?,
                );
            }
            Some("top_k") if top_k.is_none() => {
                let parsed: u8 = match read_text(&mut field, 4).await?.parse() {
                    Ok(value) if (1..=5).contains(&value) => value,
                    _ => return Err(top_k_error()),
                };
                top_k = Some(parsed);
            }
            _ => return Err(bad_request()),
        }
    }
    if image.is_none() && image_id.is_none() {
        return Err(bad_request());
    }
    Ok(ScanRequest {
        image,
        image_id,
        mode: mode.unwrap_or(pipeline::ScanMode::Multi),
        purpose: purpose.unwrap_or(pipeline::ScanPurpose::Checkout),
        top_k: top_k.unwrap_or(4),
    })
}

fn unsupported_media_type() -> ApiError {
    ApiError::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_media_type",
        "expected a JPEG or PNG image",
    )
}

fn top_k_error() -> ApiError {
    ApiError::validation_failed("top_k must be between 1 and 5")
}

/// MIME type without parameters, lowercased.
fn declared_mime(value: &str) -> Option<String> {
    value
        .split(';')
        .next()
        .map(|part| part.trim().to_ascii_lowercase())
}

async fn read_text(field: &mut Field<'_>, limit: usize) -> ApiResult<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(bad_request());
        }
        bytes.extend_from_slice(&chunk);
    }
    std::str::from_utf8(&bytes)
        .map(str::to_owned)
        .map_err(|_| bad_request())
}

/// JPEG/PNG magic bytes; other formats belong to `POST /v1/images`.
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    match taphoa_recognition::crop::sniff_format(bytes)? {
        image::ImageFormat::Jpeg => Some(("image/jpeg", "jpg")),
        image::ImageFormat::Png => Some(("image/png", "png")),
        _ => None,
    }
}

fn unavailable(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
}

fn object_key(extension: &str) -> String {
    format!(
        "images/{}/{}.{}",
        Utc::now().format("%Y/%m"),
        Uuid::new_v4(),
        extension
    )
}

async fn record_original(
    storage: &dyn ObjectStore,
    repository: &dyn crate::images::ImageRepository,
    actor: &Actor,
    purpose: pipeline::ScanPurpose,
    bytes: &[u8],
) -> ApiResult<ImageRow> {
    let Some((content_type, extension)) = sniff_image(bytes) else {
        return Err(unsupported_media_type());
    };
    let row = ImageRow {
        id: Uuid::new_v4(),
        object_key: object_key(extension),
        content_type: content_type.into(),
        byte_size: bytes.len() as i64,
        purpose: purpose.as_str().into(),
    };
    storage
        .put(&row.object_key, content_type, bytes.to_vec())
        .await
        .map_err(pipeline::storage_failure)?;
    if let Err(error) = repository.insert(&row, actor).await {
        if let Err(cleanup) = storage.delete(&row.object_key).await {
            tracing::error!(%cleanup, "failed to delete object after image insert failure");
        }
        return Err(pipeline::database_failure(error));
    }
    Ok(row)
}

async fn delete_quietly(storage: &dyn ObjectStore, keys: &[String], reason: &'static str) {
    for key in keys {
        if let Err(error) = storage.delete(key).await {
            tracing::error!(%error, reason);
        }
    }
}

async fn create_scan(
    State(state): State<AppState>,
    actor: Actor,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json<pipeline::ScanResponse>)> {
    let wall = Instant::now();
    // Cheap early rejection while the slot is taken; the permit itself is only held around
    // the blocking segment + embed work below, so storage and database I/O of other scans
    // is never serialized behind it (architecture 5.3).
    if state.inference_slots.available_permits() == 0 {
        return Err(busy());
    }
    let (segmenter, embedder, vector_index) = match (
        state.segmenter.as_ref().map(Arc::clone),
        state.embedder.as_ref().map(Arc::clone),
        state.vector_index.as_ref().map(Arc::clone),
    ) {
        (Some(segmenter), Some(embedder), Some(vector_index)) => {
            (segmenter, embedder, vector_index)
        }
        _ => return Err(no_model()),
    };
    let storage = state
        .storage
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| unavailable("storage not configured"))?;
    let pool = state
        .postgres
        .clone()
        .ok_or_else(|| unavailable("postgres not configured"))?;
    let repository = state
        .image_repository
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| unavailable("postgres not configured"))?;
    let request = parse_request(multipart).await?;
    let read_ms = wall.elapsed().as_millis() as u64;
    match request.purpose {
        pipeline::ScanPurpose::Enrollment => actor.require(Action::EnrollProduct)?,
        pipeline::ScanPurpose::Checkout => actor.require(Action::Sell)?,
    }
    let (image_bytes, existing) = match &request.image {
        Some(bytes) => (bytes.clone(), None),
        None => {
            let image_id = request
                .image_id
                .filter(|_| request.image.is_none())
                .ok_or_else(bad_request)?;
            let row = repository
                .get(image_id, actor.store_id)
                .await
                .map_err(pipeline::database_failure)?
                .ok_or_else(|| {
                    ApiError::new(StatusCode::NOT_FOUND, "not_found", "image not found")
                })?;
            (
                storage
                    .get(&row.object_key)
                    .await
                    .map_err(pipeline::storage_failure)?,
                Some(row),
            )
        }
    };
    // Only JPEG and PNG reach the decoders, whatever the declared content type said.
    if sniff_image(&image_bytes).is_none() {
        return Err(unsupported_media_type());
    }
    // Taken before anything is stored, so a busy slot leaves no orphan original behind.
    let permit = state
        .inference_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let config = state.recognition;
    let block_embedder = Arc::clone(&embedder);
    let block_segmenter = Arc::clone(&segmenter);
    let mode = request.mode;
    let pipeline_bytes = image_bytes.clone();
    // Storing the original (a bucket round trip) overlaps with inference.
    let record = async {
        match existing {
            Some(row) => Ok(row),
            None => {
                record_original(
                    storage.as_ref(),
                    repository.as_ref(),
                    &actor,
                    request.purpose,
                    &image_bytes,
                )
                .await
            }
        }
    };
    // Both blocking jobs retain the admission permit, including after cancellation or
    // detector timeout. Slow OCR cannot create an unbounded background inference queue.
    let permit = Arc::new(permit);
    let detector_permit = Arc::clone(&permit);
    let document_task = state.text_detector.clone().map(|detector| {
        let bytes = image_bytes.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = detector_permit;
            detector.document_signal(&bytes)
        })
    });
    let inference = tokio::task::spawn_blocking(move || {
        let _permit = permit; // Held even if the HTTP request is cancelled.
        pipeline::block_pipeline(
            &*block_segmenter,
            &*block_embedder,
            &pipeline_bytes,
            mode,
            config.max_detections,
        )
    });
    let record = async {
        let started = Instant::now();
        let row = record.await;
        (row, started.elapsed().as_millis() as u64)
    };
    let (original, inference) = tokio::join!(record, inference);
    let (original, original_ms) = original;
    let original = original?;
    let work: pipeline::BlockingResult = match inference {
        Ok(Ok(work)) => work,
        Ok(Err(pipeline::StageError::InvalidImage(_))) => {
            return Err(ApiError::validation_failed("could not decode the image"));
        }
        Ok(Err(pipeline::StageError::Inference(error))) => {
            tracing::error!(%error, "recognition inference failed");
            return Err(ApiError::internal());
        }
        Err(error) => {
            tracing::error!(%error, "scan task failed");
            return Err(ApiError::internal());
        }
    };
    // Detection overlaps SAM. Bound any tail latency, degrading to the absent signal
    // on detector failure/overload rather than delaying a checkout scan.
    let document = match document_task {
        Some(task) => {
            match tokio::time::timeout(std::time::Duration::from_millis(50), task).await {
                Ok(Ok(Ok(signal))) => signal,
                _ => pipeline::no_document(),
            }
        }
        None => pipeline::no_document(),
    };
    // Concurrent vector searches, then a single metadata query for all hits.
    let search_wall = Instant::now();
    let searches = work.detections.iter().map(|detection| {
        let index = Arc::clone(&vector_index);
        let embedder = Arc::clone(&embedder);
        let embedding = detection.embedding.clone();
        async move {
            index
                .search(
                    actor.store_id,
                    embedder.model(),
                    &embedding,
                    usize::from(request.top_k),
                )
                .await
        }
    });
    let hits: Vec<Vec<VectorHit>> = join_all(searches)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            crate::error::log_anyhow_error!(error, &error, "vector search failed");
            ApiError::internal()
        })?;
    let search_ms = search_wall.elapsed().as_secs_f64() * 1000.0;
    let mut product_ids: Vec<Uuid> = hits
        .iter()
        .flatten()
        .map(|hit| hit.product_id)
        .collect::<Vec<_>>();
    product_ids.sort_unstable();
    product_ids.dedup();
    let products = pipeline::product_metadata(&pool, actor.store_id, product_ids)
        .await
        .map_err(pipeline::database_failure)?;
    // Enrollment runs the plain classification with the duplicate threshold (C2).
    let threshold = match request.purpose {
        pipeline::ScanPurpose::Enrollment => config.duplicate_threshold,
        pipeline::ScanPurpose::Checkout => config.match_threshold,
    };
    let rated: Vec<pipeline::RatedDetection> = std::iter::zip(&work.detections, hits)
        .map(|(detection, hits)| pipeline::RatedDetection {
            bbox: detection.bbox,
            score: detection.score,
            area: detection.area,
            embedding: detection.embedding.clone(),
            thumbnail: detection.thumbnail.clone(),
            class: classify::classify(
                hits.first().map(|hit| hit.similarity),
                hits.get(1).map(|hit| hit.similarity),
                threshold,
                config.match_margin,
                config.match_floor,
            ),
            candidates: pipeline::candidate_displays(&hits, &products),
        })
        .collect();
    let ordered = pipeline::arrange_display_order(rated);
    // Crop thumbnails reach the bucket once; only object keys are persisted.
    // A bucket round trip costs ~0.85 s on Railway, a third of the 3 s budget, and the phone
    // only needs the thumbnails after it has rendered the lines. They upload concurrently in
    // the background while the scan is persisted; a failure is logged and the row's
    // presigned URL will 404 (thumbnails are cosmetic, labels live in the database).
    let crop_keys: Vec<String> = ordered.iter().map(|_| object_key("jpg")).collect();
    let uploads: Vec<(String, Vec<u8>)> = ordered
        .iter()
        .zip(&crop_keys)
        .map(|(detection, key)| (key.clone(), detection.thumbnail.clone()))
        .collect();
    let upload_task = {
        let storage = Arc::clone(&storage);
        tokio::spawn(async move {
            let results = futures_util::future::join_all(
                uploads
                    .iter()
                    .map(|(key, bytes)| storage.put(key, "image/jpeg", bytes.clone())),
            )
            .await;
            let failed = results.iter().filter(|result| result.is_err()).count();
            if failed > 0 {
                tracing::error!(failed, "crop thumbnail uploads failed");
            }
            failed
        })
    };
    let detections_persist: Vec<pipeline::PersistDetection> = ordered
        .iter()
        .zip(&crop_keys)
        .map(|(detection, key)| pipeline::PersistDetection {
            id: Uuid::new_v4(),
            bbox: detection.bbox,
            score: detection.score,
            area: detection.area,
            crop_key: key.clone(),
            thumbnail_bytes: detection.thumbnail.len(),
            embedding: detection.embedding.clone(),
            class: detection.class,
            candidates: detection
                .candidates
                .iter()
                .map(|c| c.snapshot.clone())
                .collect(),
        })
        .collect();
    let detection_ids: Vec<Uuid> = detections_persist
        .iter()
        .map(|detection| detection.id)
        .collect();
    let mut timings_ms = pipeline::timings_value(
        work.segment_ms,
        work.embed_ms,
        search_ms,
        wall.elapsed().as_secs_f64() * 1000.0,
    );
    // Keep the signal in the existing scan snapshot; render_scan exposes it at the
    // contract's top level and removes this internal timing entry.
    timings_ms["document"] = serde_json::to_value(document).map_err(|_| ApiError::internal())?;
    let persist_started = Instant::now();
    let (scan_id, created_at, catalog_version) = match pipeline::persist_scan(
        &pool,
        &actor,
        pipeline::ScanDraft {
            image_id: original.id,
            mode: request.mode,
            purpose: request.purpose,
            embedder_model: embedder.model().to_owned(),
            wall_time_ms: wall.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            timings_ms: timings_ms.clone(),
        },
        &detections_persist,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            // Wait for the in-flight uploads, then remove them: nothing references them.
            let cleanup_storage = Arc::clone(&storage);
            let cleanup_keys = crop_keys.clone();
            tokio::spawn(async move {
                let _ = upload_task.await;
                delete_quietly(
                    cleanup_storage.as_ref(),
                    &cleanup_keys,
                    "failed to delete crop thumbnails after scan insert failure",
                )
                .await;
            });
            return Err(pipeline::database_failure(error));
        }
    };
    let display: Vec<pipeline::DetectionDisplay> = ordered
        .into_iter()
        .zip(crop_keys)
        .zip(detection_ids)
        .map(|((detection, crop_key), id)| pipeline::DetectionDisplay {
            id,
            bbox: detection.bbox,
            score: detection.score,
            crop_key: Some(crop_key),
            class: detection.class,
            candidates: detection.candidates,
        })
        .collect();
    let scan = pipeline::ScanDisplay {
        id: scan_id,
        store_id: actor.store_id,
        original,
        mode: request.mode,
        purpose: request.purpose,
        segmenter: pipeline::SCAN_SEGMENTER.to_string(),
        embedder: embedder.model().to_string(),
        catalog_version,
        timings_ms,
        created_at,
        detections: display,
    };
    let response = pipeline::render_scan(storage.as_ref(), state.image_url_ttl, scan).await?;
    let (segment_ms, embed_ms, search_ms, total_ms) = (
        work.segment_ms.round() as u64,
        work.embed_ms.round() as u64,
        search_ms.round() as u64,
        wall.elapsed().as_millis() as u64,
    );
    tracing::info!(
        scan_id = %scan_id,
        detections = response.detections.len(),
        segment_ms,
        embed_ms,
        search_ms,
        read_ms,
        original_ms,
        persist_ms = persist_started.elapsed().as_millis() as u64,
        total_ms,
        "recognition scan complete"
    );
    Ok((StatusCode::CREATED, Json(response)))
}

fn bbox_of(value: &[f32]) -> ApiResult<[f32; 4]> {
    <[f32; 4]>::try_from(value).map_err(|_| ApiError::internal())
}

async fn get_scan(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
) -> ApiResult<Json<pipeline::ScanResponse>> {
    let scan_id: Uuid = raw_id
        .parse()
        .map_err(|_| ApiError::validation_failed("scanId must be a UUID"))?;
    let storage = state
        .storage
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| unavailable("storage not configured"))?;
    let pool = state
        .postgres
        .clone()
        .ok_or_else(|| unavailable("postgres not configured"))?;
    let repository = state
        .image_repository
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| unavailable("postgres not configured"))?;
    // Store-scoped query: another store's scan reads as not found.
    let Some(row) = pipeline::load_scan(&pool, scan_id, actor.store_id).await? else {
        return Err(ApiError::not_found());
    };
    let stored = pipeline::load_detections(&pool, scan_id).await?;
    let original = repository
        .get(row.image_id, actor.store_id)
        .await
        .map_err(pipeline::database_failure)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found", "image not found"))?;
    let mut product_ids: Vec<Uuid> = stored
        .iter()
        .flat_map(|detection| detection.candidates.iter().map(|c| c.product_id))
        .collect::<Vec<_>>();
    product_ids.sort_unstable();
    product_ids.dedup();
    let products = pipeline::product_metadata(&pool, actor.store_id, product_ids)
        .await
        .map_err(pipeline::database_failure)?;
    let detections: Vec<pipeline::DetectionDisplay> = stored
        .into_iter()
        .map(
            |detection| -> Result<pipeline::DetectionDisplay, ApiError> {
                Ok(pipeline::DetectionDisplay {
                    id: detection.id,
                    bbox: bbox_of(&detection.bbox)?,
                    score: detection.score,
                    crop_key: detection.crop_key,
                    class: detection.class,
                    candidates: detection
                        .candidates
                        .into_iter()
                        .map(|snapshot| CandidateDisplay {
                            thumbnail_key: products
                                .get(&snapshot.product_id)
                                .and_then(|info| info.thumbnail_key.clone()),
                            snapshot,
                        })
                        .collect(),
                })
            },
        )
        .collect::<Result<Vec<_>, _>>()?;
    let scan = pipeline::ScanDisplay {
        id: scan_id,
        store_id: actor.store_id,
        original,
        mode: row.mode,
        purpose: row.purpose,
        segmenter: row.segmenter,
        embedder: row.embedder,
        catalog_version: row.catalog_version,
        timings_ms: row.timings_ms,
        created_at: row.created_at,
        detections,
    };
    let response = pipeline::render_scan(storage.as_ref(), state.image_url_ttl, scan).await?;
    Ok(Json(response))
}
