use super::{Actor, ClerkIdentity, Role, crypto::*, data::*};
use crate::{ApiError, ApiResult, AppState, error::ValidJson};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};
use uuid::Uuid;

type Peer = Option<Extension<ConnectInfo<SocketAddr>>>;
async fn ip_limit(
    state: &AppState,
    headers: &HeaderMap,
    peer: Peer,
    scope: &str,
    limit: u32,
    seconds: u64,
) -> ApiResult<()> {
    let ip = state
        .client_ip
        .resolve(headers, peer.map(|Extension(ConnectInfo(addr))| addr.ip()));
    let decision = state
        .rate_limiter
        .hit(
            &format!("auth:{scope}:{ip}"),
            limit,
            Duration::from_secs(seconds),
        )
        .await
        .map_err(|_| ApiError::unavailable())?;
    if decision.allowed {
        Ok(())
    } else {
        Err(ApiError::too_many_requests(decision.retry_after_secs))
    }
}
#[derive(Deserialize)]
pub struct CreateStore {
    store_name: String,
    display_name: String,
    bank_account: Option<BankAccount>,
}
pub async fn create_store(
    State(state): State<AppState>,
    identity: ClerkIdentity,
    headers: HeaderMap,
    peer: Peer,
    ValidJson(input): ValidJson<CreateStore>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ip_limit(
        &state,
        &headers,
        peer,
        "create",
        state.rate_limits.store_create_per_hour,
        3600,
    )
    .await?;
    length(&input.store_name, 1, 80)?;
    length(&input.display_name, 1, 40)?;
    if let Some(bank) = &input.bank_account {
        bank.validate()?;
    }
    let store_id = Uuid::new_v4();
    let member_id = Uuid::new_v4();
    let mut tx = pool(&state)?.begin().await?;
    let bank = input.bank_account;
    sqlx::query("INSERT INTO stores(id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(store_id).bind(input.store_name).bind(bank.as_ref().map(|b|&b.bank_bin)).bind(bank.as_ref().and_then(|b|b.bank_short_name.as_ref())).bind(bank.as_ref().map(|b|&b.account_number)).bind(bank.as_ref().map(|b|&b.account_name)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO members(id,store_id,display_name,role,can_enroll,clerk_user_id) VALUES($1,$2,$3,'lead',true,$4)")
        .bind(member_id).bind(store_id).bind(input.display_name).bind(&identity.user_id).execute(&mut *tx).await?;
    let actor = Actor {
        clerk_user_id: identity.user_id,
        member_id,
        store_id,
        clerk_session_id: identity.session_id,
        role: Role::Lead,
        can_enroll: true,
    };
    sqlx::query(
        "INSERT INTO change_log(store_id,entity,entity_id,op) VALUES($1,'store',$1,'upsert')",
    )
    .bind(store_id)
    .execute(&mut *tx)
    .await?;
    crate::events::emit(
        &mut tx,
        crate::events::Event {
            store_id,
            actor: Some(actor.event_actor()),
            typ: "store.created",
            version: 1,
            data: json!({}),
            change: None,
        },
    )
    .await?;
    member_event(&mut tx, &actor, member_id, "joined").await?;
    let result = json!({"store":store(&mut tx,store_id).await?,"member":member(&mut tx,store_id,member_id).await?.json()});
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)))
}
#[derive(Deserialize)]
pub struct Join {
    invite_token: String,
    display_name: String,
}
pub async fn join(
    State(state): State<AppState>,
    identity: ClerkIdentity,
    headers: HeaderMap,
    peer: Peer,
    ValidJson(input): ValidJson<Join>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ip_limit(
        &state,
        &headers,
        peer,
        "join",
        state.rate_limits.join_per_hour,
        3600,
    )
    .await?;
    length(&input.display_name, 1, 40)?;
    let mut tx = pool(&state)?.begin().await?;
    // Read the store first, then lock the parent before the invite and membership:
    // member updates and event publication take the same parent lock.
    let hash = token_hash(&input.invite_token);
    let unavailable = || {
        ApiError::new(
            StatusCode::GONE,
            "invite_unavailable",
            "invite expired, used or unknown",
        )
    };
    let store_id: Uuid = sqlx::query_scalar("SELECT store_id FROM invites WHERE token_hash=$1")
        .bind(&hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(unavailable)?;
    lock_store(&mut tx, store_id).await?;
    let existing: Option<(Uuid, bool)> = sqlx::query_as(
        "SELECT id,active FROM members WHERE store_id=$1 AND clerk_user_id=$2 FOR UPDATE",
    )
    .bind(store_id)
    .bind(&identity.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    // Before requiring an unused invite: a retried join (lost response, double tap) by
    // a member who is already active has consumed that invite itself.
    if existing.is_some_and(|(_, active)| active) {
        return Err(ApiError::conflict(
            "already_member",
            "already an active member of this store",
        ));
    }
    let invite:Option<(Uuid,String,bool)>=sqlx::query_as("SELECT id,role,can_enroll FROM invites WHERE store_id=$1 AND token_hash=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE").bind(store_id).bind(&hash).fetch_optional(&mut *tx).await?;
    let (invite_id, role, enroll) = invite.ok_or_else(unavailable)?;
    let member_id = existing.map(|m| m.0).unwrap_or_else(Uuid::new_v4);
    if existing.is_some() {
        sqlx::query("UPDATE members SET active=true,display_name=$3,role=$4,can_enroll=$5,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2")
            .bind(store_id).bind(member_id).bind(&input.display_name).bind(&role).bind(role=="lead"||enroll).execute(&mut *tx).await?;
    } else {
        sqlx::query("INSERT INTO members(id,store_id,display_name,role,can_enroll,clerk_user_id) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(member_id).bind(store_id).bind(&input.display_name).bind(&role).bind(role=="lead"||enroll).bind(&identity.user_id).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE invites SET used_at=now(),used_by=$2 WHERE id=$1")
        .bind(invite_id)
        .bind(member_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor {
        clerk_user_id: identity.user_id,
        member_id,
        store_id,
        clerk_session_id: identity.session_id,
        role: role.parse()?,
        can_enroll: role == "lead" || enroll,
    };
    member_event(&mut tx, &actor, member_id, "joined").await?;
    let result = json!({"store":store(&mut tx,store_id).await?,"member":member(&mut tx,store_id,member_id).await?.json()});
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)))
}
pub async fn me(State(state): State<AppState>, identity: ClerkIdentity) -> ApiResult<Json<Value>> {
    let mut conn = pool(&state)?.acquire().await?;
    let members:Vec<MemberRow>=sqlx::query_as("SELECT id,store_id,display_name,role,can_enroll,pin_hash,active,created_at FROM members WHERE clerk_user_id=$1 AND active ORDER BY created_at,id").bind(&identity.user_id).fetch_all(&mut *conn).await?;
    let mut memberships = Vec::with_capacity(members.len());
    for member in members {
        memberships
            .push(json!({"store":store(&mut conn,member.store_id).await?,"member":member.json()}));
    }
    drop(conn);
    let profile = state
        .profile
        .get(&identity.user_id, state.redis.as_ref())
        .await;
    Ok(Json(
        json!({"clerk_user_id":identity.user_id,"profile":profile,"memberships":memberships}),
    ))
}
#[derive(Deserialize)]
pub struct VerifyPin {
    pin: String,
}
pub async fn verify_member_pin(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(input): ValidJson<VerifyPin>,
) -> ApiResult<StatusCode> {
    validate_pin(&input.pin)?;
    let mut conn = pool(&state)?.acquire().await?;
    let member = member(&mut conn, actor.store_id, actor.member_id).await?;
    drop(conn);
    if let Some(hash) = member.pin_hash {
        verify_pin(&state, actor.member_id, Some(input.pin), hash).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
fn validate_pin(pin: &str) -> ApiResult<()> {
    if !(4..=6).contains(&pin.len()) || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::validation_failed(
            "PIN must contain 4 to 6 digits",
        ));
    }
    Ok(())
}
pub async fn verify_pin(
    state: &AppState,
    member_id: Uuid,
    pin: Option<String>,
    hash: String,
) -> ApiResult<()> {
    let key = format!("pin_fail:{member_id}");
    let lock = format!("{key}:lock");
    let window = Duration::from_secs(300);
    let cap = state.rate_limits.pin_attempts;
    let unavailable = |_| ApiError::unavailable();
    let lock_out = || async {
        let locked = state
            .rate_limiter
            .hit(&lock, 0, window)
            .await
            .map_err(unavailable)?;
        Err(ApiError::too_many_requests(locked.retry_after_secs))
    };
    let decision = state
        .rate_limiter
        .check(&lock, 0)
        .await
        .map_err(unavailable)?;
    if !decision.allowed {
        return Err(ApiError::too_many_requests(decision.retry_after_secs));
    }
    // Count the attempt before verifying it. Hashing is slow, so counting only a failure
    // afterwards would let any number of parallel requests each try a PIN before the cap
    // trips. The increment is atomic: at most `cap` guesses are verified per window.
    let attempt = state
        .rate_limiter
        .hit(&key, cap, window)
        .await
        .map_err(unavailable)?;
    if !attempt.allowed {
        return lock_out().await;
    }
    if let Some(pin) = pin
        && verify_secret(pin, hash).await?
    {
        state.rate_limiter.reset(&key).await.map_err(unavailable)?;
        return Ok(());
    }
    // The last permitted guess being wrong locks the member out for the rest of the window.
    let exhausted = !state
        .rate_limiter
        .check(&key, cap.saturating_sub(1))
        .await
        .map_err(unavailable)?
        .allowed;
    if exhausted {
        return lock_out().await;
    }
    Err(ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_pin",
        "missing or invalid PIN",
    ))
}
pub async fn set_pin(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(input): ValidJson<Value>,
) -> ApiResult<StatusCode> {
    let pin = input
        .get("pin")
        .ok_or_else(|| ApiError::validation_failed("pin is required"))?;
    let hash = if pin.is_null() {
        None
    } else {
        let pin = pin
            .as_str()
            .ok_or_else(|| ApiError::validation_failed("invalid PIN"))?;
        if !(4..=6).contains(&pin.len()) || !pin.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ApiError::validation_failed(
                "PIN must contain 4 to 6 digits",
            ));
        }
        Some(hash_secret(pin.to_owned()).await?)
    };
    let mut tx = pool(&state)?.begin().await?;
    lock_store(&mut tx, actor.store_id).await?;
    sqlx::query("UPDATE members SET pin_hash=$3,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2").bind(actor.store_id).bind(actor.member_id).bind(hash).execute(&mut *tx).await?;
    member_event(&mut tx, &actor, actor.member_id, "updated").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
