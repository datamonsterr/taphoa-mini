//! Catalog module (E3): categories, products, product images, price history, price-list export.
use crate::AppState;
use axum::{
    Router,
    routing::{delete, get, post},
};

pub(crate) mod categories;
pub(crate) mod enroll;
pub mod index_jobs;
pub(crate) mod model;
pub(crate) mod price_history;
pub(crate) mod product_images;
pub(crate) mod products;

mod export;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/categories",
            get(categories::list).post(categories::create),
        )
        .route("/v1/products", get(products::list).post(products::create))
        .route(
            "/v1/products/{productId}",
            get(products::get_product)
                .patch(products::patch_product)
                .delete(products::archive_product),
        )
        .route(
            "/v1/products/{productId}/price-history",
            get(price_history::list),
        )
        .route("/v1/products/{productId}/images", post(product_images::add))
        .route(
            "/v1/products/{productId}/images/{imageId}",
            delete(product_images::remove),
        )
        .merge(export::routes())
}
