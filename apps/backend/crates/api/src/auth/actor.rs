use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts},
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Lead,
    Seller,
}
impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Seller => "seller",
        }
    }
}
impl FromStr for Role {
    type Err = ApiError;
    fn from_str(value: &str) -> ApiResult<Self> {
        match value {
            "lead" => Ok(Self::Lead),
            "seller" => Ok(Self::Seller),
            _ => Err(ApiError::validation_failed("invalid role")),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub member_id: Uuid,
    pub store_id: Uuid,
    pub session_id: Uuid,
    pub role: Role,
    pub can_enroll: bool,
}
impl FromRequestParts<AppState> for Actor {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(ApiError::unauthorized)?;
        let (scheme, token) = header.split_once(' ').ok_or_else(ApiError::unauthorized)?;
        if !scheme.eq_ignore_ascii_case("Bearer")
            || token.is_empty()
            || token.contains(char::is_whitespace)
        {
            return Err(ApiError::unauthorized());
        }
        let mut actor = state.jwt.verify(token)?;
        if let Some(pool) = &state.postgres {
            let member:Option<(String,bool)>=sqlx::query_as("SELECT m.role,m.can_enroll FROM sessions s JOIN members m ON m.id=s.member_id AND m.store_id=s.store_id WHERE s.id=$1 AND s.store_id=$2 AND s.member_id=$3 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.active")
                .bind(actor.session_id).bind(actor.store_id).bind(actor.member_id).fetch_optional(pool).await?;
            let (role, enroll) = member.ok_or_else(ApiError::unauthorized)?;
            actor.role = role.parse()?;
            actor.can_enroll = actor.role == Role::Lead || enroll;
        }
        crate::telemetry::record_identity(&actor);
        Ok(actor)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    #[tokio::test]
    async fn extracts_without_services_and_rejects_bad_headers() {
        let state = AppState::default();
        let actor = Actor {
            member_id: Uuid::new_v4(),
            store_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            role: Role::Seller,
            can_enroll: true,
        };
        let (token, _) = state.jwt.issue(&actor);
        for header in [
            None,
            Some("Basic abc"),
            Some("Bearer"),
            Some("Bearer bad"),
            Some("Bearer "),
        ] {
            let mut request = Request::builder();
            if let Some(value) = header {
                request = request.header(AUTHORIZATION, value);
            }
            let (mut parts, _) = request.body(()).unwrap().into_parts();
            assert_eq!(
                Actor::from_request_parts(&mut parts, &state)
                    .await
                    .unwrap_err()
                    .code,
                "unauthorized"
            );
        }
        let (mut parts, _) = Request::builder()
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .body(())
            .unwrap()
            .into_parts();
        assert_eq!(
            Actor::from_request_parts(&mut parts, &state).await.unwrap(),
            actor
        );
        assert_eq!(Role::from_str("lead").unwrap().as_str(), "lead");
        assert!(Role::from_str("admin").is_err());
    }
}
