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
/// Verified Clerk identity, independent of any store membership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClerkIdentity {
    pub user_id: String,
    pub session_id: String,
}
impl FromRequestParts<AppState> for ClerkIdentity {
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
        let claims = state.clerk.verify(token).await?;
        Ok(Self {
            user_id: claims.user_id,
            session_id: claims.session_id,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub clerk_user_id: String,
    pub member_id: Uuid,
    pub store_id: Uuid,
    pub clerk_session_id: String,
    pub role: Role,
    pub can_enroll: bool,
}
impl Actor {
    pub fn event_actor(&self) -> (Uuid, String) {
        (self.member_id, self.clerk_session_id.clone())
    }
}
impl FromRequestParts<AppState> for Actor {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        Self::resolve(parts, state, true).await
    }
}
/// The caller as an `Actor` without the PIN-lock check. Only the endpoints that unlock a session
/// (`POST /v1/me/pin/verify`) may use it; every other route takes `Actor`.
pub struct LockedActor(pub Actor);
impl FromRequestParts<AppState> for LockedActor {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        Actor::resolve(parts, state, false).await.map(Self)
    }
}
impl Actor {
    async fn resolve(parts: &mut Parts, state: &AppState, enforce_pin: bool) -> ApiResult<Self> {
        let identity = ClerkIdentity::from_request_parts(parts, state).await?;
        let selected = parts
            .headers
            .get("X-Store-Id")
            .map(|header| {
                header
                    .to_str()
                    .ok()
                    .and_then(|id| id.parse::<Uuid>().ok())
                    .ok_or_else(|| ApiError::validation_failed("invalid X-Store-Id"))
            })
            .transpose()?;
        let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
        let memberships: Vec<(Uuid,Uuid,String,bool,bool)> = sqlx::query_as(
            "SELECT id,store_id,role,can_enroll,pin_hash IS NOT NULL FROM members WHERE clerk_user_id=$1 AND active ORDER BY created_at,id")
            .bind(&identity.user_id).fetch_all(pool).await?;
        if memberships.is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::FORBIDDEN,
                "membership_required",
                "active store membership required",
            ));
        }
        let membership = if let Some(store) = selected {
            memberships
                .iter()
                .find(|m| m.1 == store)
                .ok_or_else(ApiError::forbidden)?
        } else if memberships.len() == 1 {
            &memberships[0]
        } else {
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_REQUEST,
                "store_required",
                "X-Store-Id is required",
            ));
        };
        // A PIN on any membership locks the person's session until it is verified, whichever
        // store the request names: the app asks for one PIN per person, not per store.
        if enforce_pin && memberships.iter().any(|m| m.4) {
            super::pin_lock::require_unlocked(pool, &identity.session_id, &identity.user_id)
                .await?;
        }
        let role: Role = membership.2.parse()?;
        let actor = Self {
            clerk_user_id: identity.user_id,
            clerk_session_id: identity.session_id,
            member_id: membership.0,
            store_id: membership.1,
            role,
            can_enroll: role == Role::Lead || membership.3,
        };
        crate::telemetry::record_identity(&actor);
        Ok(actor)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    #[tokio::test]
    async fn rejects_invalid_credentials_without_services() {
        for header in [
            None,
            Some("Basic abc"),
            Some("Bearer"),
            Some("Bearer bad"),
            Some("Bearer "),
            Some("Bearer a b"),
        ] {
            let mut request = Request::builder();
            if let Some(header) = header {
                request = request.header(AUTHORIZATION, header);
            }
            let (mut parts, _) = request.body(()).unwrap().into_parts();
            assert_eq!(
                Actor::from_request_parts(&mut parts, &AppState::default())
                    .await
                    .unwrap_err()
                    .code,
                "unauthorized"
            );
        }
        assert_eq!(Role::from_str("lead").unwrap().as_str(), "lead");
        assert!(Role::from_str("admin").is_err());
    }
}
