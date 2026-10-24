//! Enrollment helpers: image resolution, embedding and duplicate detection.
use super::products::pool;
use crate::{ApiError, ApiResult, AppState};
use serde_json::{Value, json};
use std::sync::Arc;
use taphoa_recognition::{EmbedError, Embedder, crop};
use uuid::Uuid;

use super::model::DUPLICATE_THRESHOLD;

pub(crate) struct ImageRef {
    pub id: Uuid,
    pub object_key: String,
}

pub(crate) struct DuplicateHit {
    pub product_id: Uuid,
    pub similarity: f64,
}

pub(crate) async fn resolve_images(
    state: &AppState,
    store_id: Uuid,
    ids: &[Uuid],
) -> ApiResult<Vec<ImageRef>> {
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, object_key FROM images WHERE store_id=$1 AND id = ANY($2)")
            .bind(store_id)
            .bind(ids)
            .fetch_all(pool(state)?)
            .await?;
    if rows.len() != ids.len() {
        return Err(ApiError::not_found());
    }
    // Preserve request order: position and the first-only duplicate check depend on it.
    Ok(ids
        .iter()
        .map(|id| ImageRef {
            id: *id,
            object_key: rows
                .iter()
                .find(|row| row.0 == *id)
                .expect("resolved image")
                .1
                .clone(),
        })
        .collect())
}

fn embed_error(error: EmbedError) -> ApiError {
    match error {
        EmbedError::InvalidImage(_) => ApiError::validation_failed("invalid image"),
        error => {
            tracing::error!(%error, "embedding failed");
            ApiError::unavailable()
        }
    }
}

pub(crate) async fn embed_reference(
    state: &AppState,
    embedder: Arc<dyn Embedder>,
    object_key: &str,
    cutout_key: Option<&str>,
    bbox: Option<[f32; 4]>,
) -> ApiResult<Vec<f32>> {
    let storage = state.storage.clone().ok_or_else(ApiError::unavailable)?;
    // Segment responses can precede the cutout upload. Bound the whole retry
    // window, including slow storage requests, then use the original bbox crop.
    let cutout = if let Some(key) = cutout_key {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Ok(bytes) = storage.get(key).await {
                    break bytes;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await
        .ok()
    } else {
        None
    };
    let (bytes, crop_bbox) = match cutout {
        Some(bytes) => (bytes, None),
        None => (
            storage
                .get(object_key)
                .await
                .map_err(|_| ApiError::unavailable())?,
            bbox,
        ),
    };
    let permit = state
        .inference_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let input = if let Some(bbox) = crop_bbox {
            let decoded = crop::decode_limited(&bytes).map_err(EmbedError::InvalidImage)?;
            let image = crop::crop_with_padding(
                &decoded.into_rgb8(),
                bbox,
                crate::recognition::service::CROP_PADDING,
            )
            .ok_or_else(|| EmbedError::InvalidImage("empty bbox crop".into()))?;
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, image::ImageFormat::Png)
                .map_err(|error| EmbedError::InvalidImage(error.to_string()))?;
            png.into_inner()
        } else {
            bytes
        };
        embedder.embed(&input)
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "embedding task failed");
        ApiError::internal()
    })?
    .map_err(embed_error)
}

pub(crate) fn vector_text(vector: &[f32]) -> String {
    format!(
        "[{}]",
        vector
            .iter()
            .map(f32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    )
}

const SQL_SEARCH: &str = "SELECT e.product_id, max(1.0::float8 - (e.embedding <=> $1::vector))::float8 AS similarity FROM product_embeddings e JOIN products p ON p.id = e.product_id WHERE e.store_id = $2 AND e.model = $3 AND p.store_id = $2 AND NOT p.archived GROUP BY e.product_id HAVING max(1.0::float8 - (e.embedding <=> $1::vector)) >= $4 ORDER BY similarity DESC LIMIT 5";

async fn search_sql(
    state: &AppState,
    store_id: Uuid,
    model_name: &str,
    vector: &[f32],
) -> ApiResult<Vec<DuplicateHit>> {
    let rows: Vec<(Uuid, f64)> = sqlx::query_as(SQL_SEARCH)
        .bind(vector_text(vector))
        .bind(store_id)
        .bind(model_name)
        .bind(DUPLICATE_THRESHOLD)
        .fetch_all(pool(state)?)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(product_id, similarity)| DuplicateHit {
            product_id,
            similarity,
        })
        .collect())
}

async fn search_index(
    state: &AppState,
    index: Arc<dyn crate::vector::VectorIndex>,
    store_id: Uuid,
    model_name: &str,
    vector: &[f32],
) -> ApiResult<Vec<DuplicateHit>> {
    let embedding = vector.to_vec();
    let model = model_name.to_string();
    let hits = index
        .search(store_id, &model, &embedding, 5)
        .await
        .map_err(|_| ApiError::unavailable())?;
    let ids: Vec<Uuid> = hits.iter().map(|hit| hit.product_id).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM products WHERE store_id = $1 AND NOT archived AND id = ANY($2)",
    )
    .bind(store_id)
    .bind(&ids)
    .fetch_all(pool(state)?)
    .await?;
    Ok(hits
        .into_iter()
        .filter(|hit| {
            f64::from(hit.similarity) >= DUPLICATE_THRESHOLD && rows.contains(&hit.product_id)
        })
        .map(|hit| DuplicateHit {
            product_id: hit.product_id,
            similarity: f64::from(hit.similarity),
        })
        .collect())
}

/// Best duplicate per product across all reference embeddings.
pub(crate) async fn duplicate_hits(
    state: &AppState,
    store_id: Uuid,
    model_name: &str,
    vectors: &[(Uuid, Vec<f32>)],
) -> ApiResult<Vec<DuplicateHit>> {
    let mut best: Vec<DuplicateHit> = Vec::new();
    for (_, vector) in vectors {
        let hits = match &state.vector_index {
            Some(index) => search_index(state, index.clone(), store_id, model_name, vector).await?,
            None => search_sql(state, store_id, model_name, vector).await?,
        };
        for hit in hits {
            match best.iter_mut().find(|b| b.product_id == hit.product_id) {
                Some(existing) if existing.similarity < hit.similarity => {
                    existing.similarity = hit.similarity;
                }
                Some(_) => {}
                None => best.push(hit),
            }
        }
    }
    best.sort_by(|a, b| b.similarity.total_cmp(&a.similarity));
    best.truncate(5);
    Ok(best)
}

pub(crate) async fn duplicate_error(
    state: &AppState,
    store_id: Uuid,
    hits: Vec<DuplicateHit>,
) -> ApiResult<ApiError> {
    let ids: Vec<Uuid> = hits.iter().map(|hit| hit.product_id).collect();
    let rows: Vec<(Uuid, Option<String>, i64)> =
        sqlx::query_as("SELECT id, name, price FROM products WHERE store_id = $1 AND id = ANY($2)")
            .bind(store_id)
            .bind(&ids)
            .fetch_all(pool(state)?)
            .await?;
    let candidates: Vec<Value> = hits
        .iter()
        .map(|hit| {
            let row = rows.iter().find(|row| row.0 == hit.product_id);
            json!({
                "product_id": hit.product_id,
                "similarity": hit.similarity,
                "name": row.and_then(|row| row.1.clone()),
                "price": row.map(|row| row.2).unwrap_or(0),
                "default_unit_id": Value::Null,
            })
        })
        .collect();
    Ok(
        ApiError::conflict("duplicate_suspected", "a similar product already exists")
            .with_details(json!({"candidates": candidates})),
    )
}
