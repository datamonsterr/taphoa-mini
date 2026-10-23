pub mod actor;
pub mod jwt;
pub mod permissions;
pub use actor::{Actor, Role};
pub use jwt::JwtKeys;
pub use permissions::{Action, can};

pub mod crypto;
pub(crate) mod data;
mod handlers;
pub fn router() -> axum::Router<crate::AppState> {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/v1/stores", post(handlers::create_store))
        .route("/v1/auth/join", post(handlers::join))
        .route("/v1/auth/recover", post(handlers::recover))
        .route("/v1/auth/refresh", post(handlers::refresh))
        .route("/v1/auth/switch", post(handlers::switch))
        .route("/v1/auth/logout", post(handlers::logout))
        .route("/v1/me", get(handlers::me))
        .route("/v1/me/pin", put(handlers::set_pin))
}

#[cfg(test)]
mod tests;
