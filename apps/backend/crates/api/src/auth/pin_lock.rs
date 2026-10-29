//! Server-side PIN lock for a Clerk session (shared phone).
//!
//! Every signed-in person of a phone keeps a live Clerk session, so a session token alone proves
//! nothing about who holds the phone. A person who has a PIN is therefore only served while
//! their session is unlocked:
//!
//! - a session first seen by the API starts unlocked (creating one needs a full sign-in);
//! - `POST /v1/me/pin/lock` locks it (the app calls this when another person becomes active or
//!   the device locks);
//! - `POST /v1/me/pin/verify` with the right PIN, or setting a PIN, unlocks it;
//! - an unlocked session idle for `UNLOCK_IDLE_SECS` locks again.
//!
//! A locked session is refused with 403 `pin_required`. `/v1/me`, verify and lock stay open so
//! the app can show who is on the phone and ask for the PIN.
use crate::error::{ApiError, ApiResult};
use axum::http::StatusCode;
use sqlx::PgPool;

/// An unlocked session unused for this long locks again.
pub const UNLOCK_IDLE_SECS: i64 = 12 * 3600;

fn pin_required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "pin_required",
        "enter your PIN to use this session",
    )
}

/// Lets the request through only when the session is unlocked, and keeps it unlocked while used.
pub async fn require_unlocked(pool: &PgPool, session_id: &str, user_id: &str) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO session_pin_state(session_id,clerk_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(session_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    let open = sqlx::query_scalar::<_, i32>(
        "UPDATE session_pin_state SET touched_at=now() WHERE session_id=$1 AND clerk_user_id=$2 AND NOT locked AND touched_at > now() - $3 * interval '1 second' RETURNING 1",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(UNLOCK_IDLE_SECS as f64)
    .fetch_optional(pool)
    .await?;
    open.map(|_| ()).ok_or_else(pin_required)
}

/// Marks the session unlocked: a PIN was just verified or set by this session.
pub async fn unlock(pool: &PgPool, session_id: &str, user_id: &str) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO session_pin_state(session_id,clerk_user_id) VALUES($1,$2) ON CONFLICT (session_id) DO UPDATE SET locked=false,touched_at=now() WHERE session_pin_state.clerk_user_id=$2",
    )
    .bind(session_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Marks the session locked until its PIN is verified again.
pub async fn lock(pool: &PgPool, session_id: &str, user_id: &str) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO session_pin_state(session_id,clerk_user_id,locked) VALUES($1,$2,true) ON CONFLICT (session_id) DO UPDATE SET locked=true WHERE session_pin_state.clerk_user_id=$2",
    )
    .bind(session_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}
