use std::{net::SocketAddr, time::Duration};

use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ApiError, ApiResult, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/waitlist", post(signup))
}

#[derive(Deserialize)]
struct Signup {
    email: String,
}

fn normalize_email(input: &str) -> Option<String> {
    let email = input.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    if email.chars().count() > 254
        || local.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || email.chars().any(|c| c.is_whitespace() || c == '\0')
    {
        return None;
    }
    Some(email)
}

fn invalid_email() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_email",
        "invalid email",
    )
}

async fn signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    body: Result<Json<Signup>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let ip = state
        .client_ip
        .resolve(&headers, peer.map(|Extension(ConnectInfo(addr))| addr.ip()));
    crate::ratelimit::enforce(
        &state,
        &format!("waitlist:{ip}"),
        10,
        Duration::from_secs(60),
        "waitlist requests",
    )
    .await?;
    let email =
        normalize_email(&body.map_err(|_| invalid_email())?.0.email).ok_or_else(invalid_email)?;
    let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
    sqlx::query("INSERT INTO waitlist_signups(email) VALUES ($1) ON CONFLICT (email) DO NOTHING")
        .bind(email)
        .execute(pool)
        .await?;
    Ok(Json(json!({"status": "ok"})))
}

#[cfg(test)]
mod tests;
