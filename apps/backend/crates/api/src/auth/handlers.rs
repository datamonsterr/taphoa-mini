use super::{Actor, crypto::*, data::*};
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
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_owned())
        .or_else(|| peer.map(|Extension(ConnectInfo(addr))| addr.ip().to_string()))
        .unwrap_or_else(|| "unknown".into());
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
    device: Device,
    bank_account: Option<BankAccount>,
}
pub async fn create_store(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    ValidJson(input): ValidJson<CreateStore>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ip_limit(&state, &headers, peer, "create", 10, 3600).await?;
    length(&input.store_name, 1, 80)?;
    length(&input.display_name, 1, 40)?;
    input.device.validate()?;
    if let Some(bank) = &input.bank_account {
        bank.validate()?;
    }
    let code = recovery_code();
    let normalized = normalize_recovery(&code);
    let hash = hash_secret(normalized.clone()).await?;
    let store_id = Uuid::new_v4();
    let member_id = Uuid::new_v4();
    let mut tx = pool(&state)?.begin().await?;
    let bank = input.bank_account;
    sqlx::query("INSERT INTO stores(id,name,recovery_code_hash,recovery_code_lookup,bank_bin,bank_short_name,bank_account_number,bank_account_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(store_id).bind(input.store_name).bind(hash).bind(token_hash(&normalized)).bind(bank.as_ref().map(|b|&b.bank_bin)).bind(bank.as_ref().and_then(|b|b.bank_short_name.as_ref())).bind(bank.as_ref().map(|b|&b.account_number)).bind(bank.as_ref().map(|b|&b.account_name)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO members(id,store_id,display_name,role,can_enroll) VALUES($1,$2,$3,'lead',true)").bind(member_id).bind(store_id).bind(input.display_name).execute(&mut *tx).await?;
    let member = member(&mut tx, store_id, member_id).await?;
    let (actor, mut result) = new_session(&mut tx, &state, &member, &input.device).await?;
    sqlx::query(
        "INSERT INTO change_log(store_id,entity,entity_id,op) VALUES($1,'store',$1,'upsert')",
    )
    .bind(store_id)
    .execute(&mut *tx)
    .await?;
    member_event(&mut tx, &actor, member_id, "joined").await?;
    tx.commit().await?;
    result["recovery_code"] = json!(code);
    Ok((StatusCode::CREATED, Json(result)))
}
#[derive(Deserialize)]
pub struct Join {
    invite_token: String,
    display_name: String,
    device: Device,
}
pub async fn join(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    ValidJson(input): ValidJson<Join>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ip_limit(&state, &headers, peer, "join", 10, 3600).await?;
    length(&input.display_name, 1, 40)?;
    input.device.validate()?;
    let mut tx = pool(&state)?.begin().await?;
    let invite:Option<(Uuid,Uuid,String,bool)>=sqlx::query_as("SELECT id,store_id,role,can_enroll FROM invites WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE").bind(token_hash(&input.invite_token)).fetch_optional(&mut *tx).await?;
    let (id, store_id, role, enroll) = invite.ok_or_else(|| {
        ApiError::new(
            StatusCode::GONE,
            "invite_unavailable",
            "invite expired, used or unknown",
        )
    })?;
    sqlx::query("SELECT id FROM stores WHERE id=$1 FOR UPDATE")
        .bind(store_id)
        .execute(&mut *tx)
        .await?;
    let member_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO members(id,store_id,display_name,role,can_enroll) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(member_id)
    .bind(store_id)
    .bind(input.display_name)
    .bind(&role)
    .bind(role == "lead" || enroll)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE invites SET used_at=now(),used_by=$2 WHERE id=$1")
        .bind(id)
        .bind(member_id)
        .execute(&mut *tx)
        .await?;
    let member = member(&mut tx, store_id, member_id).await?;
    let (actor, result) = new_session(&mut tx, &state, &member, &input.device).await?;
    member_event(&mut tx, &actor, member_id, "joined").await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)))
}
#[derive(Deserialize)]
pub struct Recover {
    recovery_code: String,
    device: Device,
    #[serde(default)]
    revoke_other_sessions: bool,
}
pub async fn recover(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    ValidJson(input): ValidJson<Recover>,
) -> ApiResult<Json<Value>> {
    ip_limit(&state, &headers, peer, "recover", 5, 600).await?;
    input.device.validate()?;
    let normalized = normalize_recovery(&input.recovery_code);
    let mut tx = pool(&state)?.begin().await?;
    let found: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,recovery_code_hash FROM stores WHERE recovery_code_lookup=$1 FOR UPDATE",
    )
    .bind(token_hash(&normalized))
    .fetch_optional(&mut *tx)
    .await?;
    let (store_id, hash) = found.ok_or_else(ApiError::unauthorized)?;
    if !verify_secret(normalized, hash).await? {
        return Err(ApiError::unauthorized());
    }
    let member_id:Uuid=sqlx::query_scalar("SELECT id FROM members WHERE store_id=$1 AND role='lead' AND active ORDER BY created_at,id LIMIT 1 FOR UPDATE").bind(store_id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::unauthorized)?;
    let member = member(&mut tx, store_id, member_id).await?;
    let (actor, mut result) = new_session(&mut tx, &state, &member, &input.device).await?;
    let code = recovery_code();
    let normalized = normalize_recovery(&code);
    let hash = hash_secret(normalized.clone()).await?;
    sqlx::query("UPDATE stores SET recovery_code_hash=$2,recovery_code_lookup=$3 WHERE id=$1")
        .bind(store_id)
        .bind(hash)
        .bind(token_hash(&normalized))
        .execute(&mut *tx)
        .await?;
    if input.revoke_other_sessions {
        let ids:Vec<Uuid>=sqlx::query_scalar("UPDATE sessions SET revoked_at=now() WHERE store_id=$1 AND id<>$2 AND revoked_at IS NULL RETURNING id").bind(store_id).bind(actor.session_id).fetch_all(&mut *tx).await?;
        for id in ids {
            revoked_event(&mut tx, &actor, id, "recovery").await?;
        }
    }
    tx.commit().await?;
    result["recovery_code"] = json!(code);
    Ok(Json(result))
}
#[derive(Deserialize)]
pub struct Refresh {
    refresh_token: String,
}
pub async fn refresh(
    State(state): State<AppState>,
    ValidJson(input): ValidJson<Refresh>,
) -> ApiResult<Json<Value>> {
    let hash = token_hash(&input.refresh_token);
    let mut tx = pool(&state)?.begin().await?;
    let store_id: Uuid = sqlx::query_scalar(
        "SELECT store_id FROM sessions WHERE refresh_token_hash=$1 OR previous_token_hash=$1",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    lock_store(&mut tx, store_id).await?;

    let row:Option<(Uuid,Uuid,Uuid,Vec<u8>,bool)>=sqlx::query_as("SELECT id,store_id,member_id,refresh_token_hash,(revoked_at IS NULL AND expires_at>now()) FROM sessions WHERE refresh_token_hash=$1 OR previous_token_hash=$1 FOR UPDATE").bind(&hash).fetch_optional(&mut *tx).await?;
    let (session_id, store_id, member_id, current, valid) =
        row.ok_or_else(ApiError::unauthorized)?;
    if !valid {
        return Err(ApiError::unauthorized());
    }
    let member = member(&mut tx, store_id, member_id).await?;
    let actor = Actor {
        session_id,
        store_id,
        member_id,
        role: member.role.parse()?,
        can_enroll: member.role == "lead" || member.can_enroll,
    };
    if current != hash {
        sqlx::query("UPDATE sessions SET revoked_at=now() WHERE id=$1")
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        revoked_event(&mut tx, &actor, session_id, "token_reuse").await?;
        tx.commit().await?;
        return Err(ApiError::unauthorized());
    }
    if !member.active {
        return Err(ApiError::unauthorized());
    }
    let token = opaque_token();
    sqlx::query("UPDATE sessions SET previous_token_hash=refresh_token_hash,refresh_token_hash=$2,expires_at=now()+interval '90 days',last_seen_at=now() WHERE id=$1").bind(session_id).bind(token_hash(&token)).execute(&mut *tx).await?;
    let result = session_response(&mut tx, &state, &actor, &token).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
pub struct Switch {
    member_id: Uuid,
    pin: Option<String>,
}
pub async fn verify_pin(
    state: &AppState,
    member_id: Uuid,
    pin: Option<String>,
    hash: String,
) -> ApiResult<()> {
    let key = format!("pin_fail:{member_id}");
    let lock = format!("{key}:lock");
    let decision = state
        .rate_limiter
        .check(&lock, 0)
        .await
        .map_err(|_| ApiError::unavailable())?;
    if !decision.allowed {
        return Err(ApiError::too_many_requests(decision.retry_after_secs));
    }
    if let Some(pin) = pin
        && verify_secret(pin, hash).await?
    {
        state
            .rate_limiter
            .reset(&key)
            .await
            .map_err(|_| ApiError::unavailable())?;
        return Ok(());
    }
    let failed = state
        .rate_limiter
        .hit(&key, 4, Duration::from_secs(300))
        .await
        .map_err(|_| ApiError::unavailable())?;
    if !failed.allowed {
        let locked = state
            .rate_limiter
            .hit(&lock, 0, Duration::from_secs(300))
            .await
            .map_err(|_| ApiError::unavailable())?;
        return Err(ApiError::too_many_requests(locked.retry_after_secs));
    }
    Err(ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_pin",
        "missing or invalid PIN",
    ))
}
pub async fn switch(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(input): ValidJson<Switch>,
) -> ApiResult<Json<Value>> {
    let mut tx = pool(&state)?.begin().await?;
    lock_store(&mut tx, actor.store_id).await?;
    let member = member(&mut tx, actor.store_id, input.member_id).await?;
    if !member.active {
        return Err(ApiError::not_found());
    }
    if let Some(hash) = &member.pin_hash {
        verify_pin(&state, member.id, input.pin, hash.clone()).await?;
    }
    let device:(String,String,Option<String>)=sqlx::query_as("SELECT device_name,platform,app_version FROM sessions WHERE store_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE").bind(actor.store_id).bind(actor.session_id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::unauthorized)?;
    let (_, result) = new_session(
        &mut tx,
        &state,
        &member,
        &Device {
            name: device.0,
            platform: device.1,
            app_version: device.2,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn logout(State(state): State<AppState>, actor: Actor) -> ApiResult<StatusCode> {
    let mut tx = pool(&state)?.begin().await?;
    lock_store(&mut tx, actor.store_id).await?;
    let result = sqlx::query(
        "UPDATE sessions SET revoked_at=now() WHERE store_id=$1 AND id=$2 AND revoked_at IS NULL",
    )
    .bind(actor.store_id)
    .bind(actor.session_id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() > 0 {
        revoked_event(&mut tx, &actor, actor.session_id, "logout").await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn me(State(state): State<AppState>, actor: Actor) -> ApiResult<Json<Value>> {
    let mut conn = pool(&state)?.acquire().await?;
    Ok(Json(
        json!({"member":member(&mut conn,actor.store_id,actor.member_id).await?.json(),"store":store(&mut conn,actor.store_id).await?}),
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
