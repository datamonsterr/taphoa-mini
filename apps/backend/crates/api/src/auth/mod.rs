pub mod actor;
pub mod clerk;
pub mod permissions;
pub mod profile;
pub use actor::{Actor, ClerkIdentity, LockedActor, Role};
pub use clerk::{ClerkClaims, ClerkSettings, ClerkVerifier};
pub use permissions::{Action, can};

pub mod crypto;
pub(crate) mod data;
mod handlers;
pub mod pin_lock;
pub fn router() -> axum::Router<crate::AppState> {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/v1/stores", post(handlers::create_store))
        .route("/v1/auth/join", post(handlers::join))
        .route("/v1/me", get(handlers::me))
        .route("/v1/me/pin", put(handlers::set_pin))
        .route("/v1/me/pin/verify", post(handlers::verify_member_pin))
        .route("/v1/me/pin/lock", post(handlers::lock_session))
}

#[cfg(test)]
mod tests;
