//! Store-scoped pull synchronization for catalog and settings.
mod feed;

use crate::AppState;
use axum::{Router, routing::get};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/sync/changes", get(feed::changes))
}
