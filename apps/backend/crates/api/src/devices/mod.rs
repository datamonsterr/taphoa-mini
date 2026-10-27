//! Push token ownership follows the latest authenticated registration.
use crate::{ApiError, ApiResult, AppState, auth::Actor, error::ValidJson};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Device {
    pub token: String,
    #[serde(skip_serializing)]
    pub store_id: Uuid,
    #[serde(skip_serializing)]
    pub member_id: Uuid,
    pub platform: String,
    pub app_version: String,
    pub language: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterDevice {
    pub token: String,
    pub platform: String,
    pub app_version: String,
    pub language: String,
}
impl RegisterDevice {
    fn validate(&self) -> ApiResult<()> {
        let valid_token = self.token.len() <= 256
            && self
                .token
                .strip_prefix("ExpoPushToken[")
                .or_else(|| self.token.strip_prefix("ExponentPushToken["))
                .and_then(|token| token.strip_suffix(']'))
                .is_some_and(|inner| {
                    (1..=200).contains(&inner.len())
                        && inner
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
                });
        if !valid_token
            || self.app_version.is_empty()
            || !["android", "ios"].contains(&self.platform.as_str())
            || !["vi", "en"].contains(&self.language.as_str())
        {
            return Err(ApiError::validation_failed("invalid device registration"));
        }
        Ok(())
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/devices", post(register))
        .route("/v1/devices/{token}", delete(unregister))
}
async fn register(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(body): ValidJson<RegisterDevice>,
) -> ApiResult<Json<Device>> {
    body.validate()?;
    let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
    let device = sqlx::query_as("INSERT INTO devices(token,store_id,member_id,platform,app_version,language) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (token) DO UPDATE SET store_id=EXCLUDED.store_id,member_id=EXCLUDED.member_id,platform=EXCLUDED.platform,app_version=EXCLUDED.app_version,language=EXCLUDED.language,updated_at=now() RETURNING *")
        .bind(body.token).bind(actor.store_id).bind(actor.member_id).bind(body.platform).bind(body.app_version).bind(body.language)
        .fetch_one(pool).await?;
    Ok(Json(device))
}
async fn unregister(
    State(state): State<AppState>,
    actor: Actor,
    Path(token): Path<String>,
) -> ApiResult<StatusCode> {
    let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
    sqlx::query("DELETE FROM devices WHERE token=$1 AND member_id=$2")
        .bind(token)
        .bind(actor.member_id)
        .execute(pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
