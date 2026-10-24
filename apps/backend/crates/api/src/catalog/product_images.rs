//! Reference photo management: persist changes and enqueue background indexing.
use super::products::{pool, signed_url};
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor},
    catalog::{enroll, model},
    error::ValidJson,
};
use axum::{Json, extract::Path, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct AddImageRequest {
    pub image_id: Uuid,
    pub detection_id: Option<Uuid>,
    pub cutout_image_id: Option<Uuid>,
    pub bbox: Option<[f32; 4]>,
}

async fn image_position(
    conn: &mut sqlx::PgConnection,
    product_id: Uuid,
    image_id: Uuid,
) -> ApiResult<Option<i16>> {
    sqlx::query_scalar(
        "SELECT position FROM product_images WHERE product_id = $1 AND image_id = $2",
    )
    .bind(product_id)
    .bind(image_id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::from)
}

async fn load_positions(conn: &mut sqlx::PgConnection, product_id: Uuid) -> ApiResult<Vec<i16>> {
    sqlx::query_scalar(
        "SELECT position FROM product_images WHERE product_id = $1 ORDER BY position",
    )
    .bind(product_id)
    .fetch_all(conn)
    .await
    .map_err(ApiError::from)
}

async fn object_key(conn: &mut sqlx::PgConnection, image_id: Uuid) -> ApiResult<String> {
    sqlx::query_scalar("SELECT object_key FROM images WHERE id = $1")
        .bind(image_id)
        .fetch_one(conn)
        .await
        .map_err(|error| match error {
            sqlx::Error::RowNotFound => ApiError::not_found(),
            other => ApiError::from(other),
        })
}
fn first_free_position(taken: Vec<i16>) -> i16 {
    let mut taken = taken;
    taken.sort_unstable();
    let mut position = 0;
    for (index, at) in taken.into_iter().enumerate() {
        let slot = index as i16;
        if at > slot {
            break;
        }
        position = slot + 1;
    }
    position
}

pub(crate) async fn add(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ValidJson(value): ValidJson<Value>,
) -> ApiResult<(axum::http::StatusCode, Json<Value>)> {
    actor.require(Action::EnrollProduct)?;
    let product_id = model::path_id(&id)?;
    let request: AddImageRequest =
        serde_json::from_value(value).map_err(|e| model::reference_validation(e.to_string()))?;
    if request.cutout_image_id.is_some() != request.bbox.is_some() {
        return Err(model::reference_validation(
            "cutout_image_id and bbox must be supplied together",
        ));
    }
    if request.detection_id.is_some() && request.bbox.is_some() {
        return Err(model::reference_validation(
            "detection_id and bbox cannot be combined",
        ));
    }
    if let Some(bbox) = request.bbox {
        model::validate_bbox(&bbox)?;
    }
    let mut ids = vec![request.image_id];
    if let Some(cutout) = request.cutout_image_id.filter(|id| *id != request.image_id) {
        ids.push(cutout);
    }
    enroll::resolve_images(&state, actor.store_id, &ids).await?;
    let mut tx = pool(&state)?.begin().await?;
    sqlx::query("SELECT 1 FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE")
        .bind(product_id)
        .bind(actor.store_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let bbox = if let Some(detection_id) = request.detection_id {
        let bbox: Vec<f32> = sqlx::query_scalar(
            "SELECT d.bbox FROM detections d JOIN scans s ON s.id=d.scan_id AND s.store_id=d.store_id
             WHERE d.id=$1 AND d.store_id=$2 AND s.image_id=$3",
        ).bind(detection_id).bind(actor.store_id).bind(request.image_id)
            .fetch_optional(&mut *tx).await?
            .ok_or_else(|| model::reference_validation("detection must belong to this image and store"))?;
        let bbox: [f32; 4] = bbox
            .try_into()
            .map_err(|_| model::reference_validation("invalid detection bbox"))?;
        model::validate_bbox(&bbox)?;
        Some(bbox)
    } else {
        request.bbox
    };

    if let Some(existing) = image_position(&mut tx, product_id, request.image_id).await? {
        let key = object_key(&mut tx, request.image_id).await?;
        let (cutout, bbox): (Option<Uuid>, Option<Vec<f32>>) = sqlx::query_as(
            "SELECT cutout_image_id, bbox FROM product_images WHERE product_id=$1 AND image_id=$2",
        )
        .bind(product_id)
        .bind(request.image_id)
        .fetch_one(&mut *tx)
        .await?;
        let bbox = bbox
            .map(<[f32; 4]>::try_from)
            .transpose()
            .map_err(|_| ApiError::internal())?;
        let (url, expires_at) = signed_url(&state, &key).await?;
        return Ok((
            axum::http::StatusCode::OK,
            Json(image_json(
                request.image_id,
                existing,
                url,
                expires_at,
                cutout,
                bbox,
            )),
        ));
    }

    let positions = load_positions(&mut tx, product_id).await?;
    if positions.len() >= model::MAX_IMAGES {
        return Err(ApiError::conflict(
            "image_limit",
            "product already has 8 images",
        ));
    }
    let position = first_free_position(positions);

    let key = object_key(&mut tx, request.image_id).await?;
    sqlx::query("INSERT INTO product_images (product_id, image_id, position, cutout_image_id, bbox) VALUES ($1,$2,$3,$4,$5)")
        .bind(product_id)
        .bind(request.image_id)
        .bind(position)
        .bind(request.cutout_image_id)
        .bind(bbox.map(|bbox| bbox.to_vec()))
        .execute(&mut *tx)
        .await?;
    super::index_jobs::enqueue(&mut tx, actor.store_id, product_id).await?;
    sqlx::query(
        "UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1 \
         AND store_id = $2",
    )
    .bind(product_id)
    .bind(actor.store_id)
    .execute(&mut *tx)
    .await?;
    crate::events::emit(
        &mut tx,
        crate::events::Event {
            store_id: actor.store_id,
            actor: Some((actor.member_id, actor.session_id)),
            typ: "catalog.changed",
            version: 1,
            data: json!({"entity": "product", "ids": [product_id]}),
            change: Some(("product", product_id, "upsert")),
        },
    )
    .await?;
    tx.commit().await?;
    let (url, expires_at) = signed_url(&state, &key).await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(image_json(
            request.image_id,
            position,
            url,
            expires_at,
            request.cutout_image_id,
            bbox,
        )),
    ))
}

pub(crate) async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    Path(path): Path<(String, String)>,
) -> ApiResult<axum::http::StatusCode> {
    actor.require(Action::EnrollProduct)?;
    let product_id = model::path_id(&path.0)?;
    let image_id = model::path_id(&path.1)?;
    let mut tx = pool(&state)?.begin().await?;
    sqlx::query("SELECT 1 FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE")
        .bind(product_id)
        .bind(actor.store_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if image_position(&mut tx, product_id, image_id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found());
    }
    if load_positions(&mut tx, product_id).await?.len() <= 1 {
        return Err(ApiError::conflict(
            "conflict",
            "product needs at least one image",
        ));
    }
    sqlx::query("DELETE FROM product_images WHERE product_id = $1 AND image_id = $2")
        .bind(product_id)
        .bind(image_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM product_embeddings WHERE product_id = $1 AND image_id = $2 AND store_id = $3",
    )
    .bind(product_id)
    .bind(image_id)
    .bind(actor.store_id)
    .execute(&mut *tx)
    .await?;
    super::index_jobs::enqueue(&mut tx, actor.store_id, product_id).await?;
    sqlx::query(
        "UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1 \
         AND store_id = $2",
    )
    .bind(product_id)
    .bind(actor.store_id)
    .execute(&mut *tx)
    .await?;
    crate::events::emit(
        &mut tx,
        crate::events::Event {
            store_id: actor.store_id,
            actor: Some((actor.member_id, actor.session_id)),
            typ: "catalog.changed",
            version: 1,
            data: json!({"entity": "product", "ids": [product_id]}),
            change: Some(("product", product_id, "upsert")),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

fn image_json(
    image_id: Uuid,
    position: i16,
    url: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    cutout: Option<Uuid>,
    bbox: Option<[f32; 4]>,
) -> Value {
    let mut value =
        json!({"image_id":image_id,"position":position,"url":url,"url_expires_at":expires_at});
    if let Some(cutout) = cutout {
        value["cutout_image_id"] = json!(cutout);
    }
    if let Some(bbox) = bbox {
        value["bbox"] = json!(bbox);
    }
    value
}
