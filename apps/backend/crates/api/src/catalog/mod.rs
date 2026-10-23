//! Catalog module (E3): categories, products, product images, price history, price-list export.
use crate::AppState;
use axum::{Router, routing::get};

pub(crate) mod categories;
pub(crate) mod model;

mod export;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/categories",
            get(categories::list).post(categories::create),
        )
        .merge(export::routes())
}
