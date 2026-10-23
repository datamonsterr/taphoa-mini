//! Catalog module (E3): categories, products, product images, price history, price-list export.
use crate::AppState;
use axum::Router;

mod export;

pub fn router() -> Router<AppState> {
    Router::new().merge(export::routes())
}
