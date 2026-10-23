//! GET /v1/exports/price-list (printable PDF / PNG). Owned by the export task.
use crate::{ApiError, AppState, auth::Actor};
use axum::{Router, extract::State, response::Response, routing::get};

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/exports/price-list", get(price_list))
}
async fn price_list(State(_state): State<AppState>, _actor: Actor) -> Result<Response, ApiError> {
    Err(ApiError::new(
        axum::http::StatusCode::NOT_IMPLEMENTED,
        "not_implemented",
        "price list export is not implemented yet",
    ))
}
