//! Store HTTP routes are supplied by the auth/store epic.
pub fn router() -> axum::Router<crate::AppState> {
    axum::Router::new()
}
