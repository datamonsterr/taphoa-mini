use crate::{ApiError, AppState, MAX_UPLOAD_BYTES, multipart_error};
use async_trait::async_trait;
use axum::{
    Json,
    extract::{Multipart, Path, State, multipart::MultipartRejection},
    http::StatusCode,
};
use chrono::Utc;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

// Permit a full 10 MiB image plus bounded multipart headers and store_id.
pub const MAX_IMAGE_REQUEST_BYTES: usize = MAX_UPLOAD_BYTES + 64 * 1024;

#[derive(Clone, sqlx::FromRow)]
pub struct ImageRow {
    pub id: Uuid,
    pub object_key: String,
    pub content_type: String,
    pub byte_size: i64,
    pub purpose: String,
}
// Mirrors the OpenAPI ImagePurpose enum; the database also allows internal `crop`.
const PURPOSES: [&str; 4] = ["enrollment", "checkout", "expense_receipt", "other"];
#[async_trait]
pub trait ImageRepository: Send + Sync {
    async fn insert(&self, row: &ImageRow, store_id: Option<Uuid>) -> Result<(), sqlx::Error>;
    async fn get(&self, id: Uuid) -> Result<Option<ImageRow>, sqlx::Error>;
}
pub struct PgImageRepository(pub PgPool);
#[async_trait]
impl ImageRepository for PgImageRepository {
    async fn insert(&self, row: &ImageRow, store_id: Option<Uuid>) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO images (id, store_id, object_key, content_type, byte_size, purpose) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(row.id).bind(store_id).bind(&row.object_key).bind(&row.content_type).bind(row.byte_size).bind(&row.purpose)
            .execute(&self.0).await?;
        Ok(())
    }
    async fn get(&self, id: Uuid) -> Result<Option<ImageRow>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, object_key, content_type, byte_size, purpose FROM images WHERE id=$1",
        )
        .bind(id)
        .fetch_optional(&self.0)
        .await
    }
}
#[derive(Serialize)]
pub struct ImageResponse {
    id: Uuid,
    object_key: String,
    content_type: String,
    byte_size: i64,
    purpose: String,
    url: String,
    url_expires_at: chrono::DateTime<Utc>,
}
fn bad_input() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "expected one image, optional store_id UUID and optional purpose",
    )
}
fn storage_error(error: anyhow::Error) -> ApiError {
    tracing::error!(%error, "object storage operation failed");
    ApiError(StatusCode::BAD_GATEWAY, "storage failure")
}
fn database_error(error: sqlx::Error) -> ApiError {
    tracing::error!(%error, "image reference query failed");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "image reference failure")
}
fn detect(bytes: &[u8]) -> Result<(&'static str, &'static str), ApiError> {
    if bytes.starts_with(b"\xff\xd8\xff") {
        Ok(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("image/png", "png"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Ok(("image/webp", "webp"))
    } else {
        Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected JPEG, PNG or WebP magic bytes",
        ))
    }
}
fn dependencies(
    state: &AppState,
) -> Result<(&dyn crate::storage::ObjectStore, &dyn ImageRepository), ApiError> {
    let storage = state.storage.as_deref().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "storage not configured",
    ))?;
    let repository = state.image_repository.as_deref().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "postgres not configured",
    ))?;
    Ok((storage, repository))
}
async fn response(state: &AppState, row: ImageRow) -> Result<Json<ImageResponse>, ApiError> {
    let (storage, _) = dependencies(state)?;
    let signed = storage
        .presign_get(&row.object_key, state.image_url_ttl)
        .await
        .map_err(storage_error)?;
    Ok(Json(ImageResponse {
        id: row.id,
        object_key: row.object_key,
        content_type: row.content_type,
        byte_size: row.byte_size,
        purpose: row.purpose,
        url: signed.url,
        url_expires_at: signed.expires_at,
    }))
}
pub(crate) async fn upload(
    State(state): State<AppState>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<(StatusCode, Json<ImageResponse>), ApiError> {
    let (storage, repository) = dependencies(&state)?;
    let mut multipart = multipart.map_err(|_| bad_input())?;
    let mut image = None;
    let mut store_id = None;
    let mut purpose = None;
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("image") if image.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len() + chunk.len() > MAX_UPLOAD_BYTES {
                        return Err(ApiError(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "image upload too large",
                        ));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if bytes.is_empty() {
                    return Err(bad_input());
                }
                image = Some(bytes);
            }
            Some("store_id") if store_id.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len() + chunk.len() > 36 {
                        return Err(bad_input());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                store_id = Some(
                    std::str::from_utf8(&bytes)
                        .map_err(|_| bad_input())?
                        .parse::<Uuid>()
                        .map_err(|_| bad_input())?,
                );
            }
            Some("purpose") if purpose.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len() + chunk.len() > 32 {
                        return Err(bad_input());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value = std::str::from_utf8(&bytes).map_err(|_| bad_input())?;
                if !PURPOSES.contains(&value) {
                    return Err(bad_input());
                }
                purpose = Some(value.to_owned());
            }
            _ => return Err(bad_input()),
        }
    }
    let bytes = image.ok_or_else(bad_input)?;
    let (content_type, extension) = detect(&bytes)?;
    let id = Uuid::new_v4();
    let row = ImageRow {
        id,
        object_key: format!("images/{}/{id}.{extension}", Utc::now().format("%Y/%m")),
        content_type: content_type.into(),
        byte_size: bytes.len() as i64,
        purpose: purpose.unwrap_or_else(|| "other".into()),
    };
    storage
        .put(&row.object_key, content_type, bytes)
        .await
        .map_err(storage_error)?;
    if let Err(error) = repository.insert(&row, store_id).await {
        if let Err(cleanup_error) = storage.delete(&row.object_key).await {
            tracing::error!(key = %row.object_key, %cleanup_error, "failed to delete object after image insert failure");
        }
        if error
            .as_database_error()
            .is_some_and(|error| error.is_foreign_key_violation())
        {
            return Err(ApiError(StatusCode::BAD_REQUEST, "unknown store_id"));
        }
        return Err(database_error(error));
    }
    Ok((StatusCode::CREATED, response(&state, row).await?))
}
pub(crate) async fn get_image(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ImageResponse>, ApiError> {
    let (_, repository) = dependencies(&state)?;
    let id = id.parse().map_err(|_| bad_input())?;
    let row = repository
        .get(id)
        .await
        .map_err(database_error)?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "image not found"))?;
    response(&state, row).await
}

#[cfg(test)]
mod tests;
