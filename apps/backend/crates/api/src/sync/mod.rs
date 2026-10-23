//! sync module. Owned by a later epic; E1 only provides the empty router.
use crate::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
