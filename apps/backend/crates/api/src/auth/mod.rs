pub mod actor;
pub mod jwt;
pub mod permissions;
pub use actor::{Actor, Role};
pub use jwt::JwtKeys;
pub use permissions::{Action, can};

pub fn router() -> axum::Router<crate::AppState> {
    axum::Router::new()
}

#[cfg(test)]
mod tests;
