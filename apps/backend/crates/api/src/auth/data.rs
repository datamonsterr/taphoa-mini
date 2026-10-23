use super::{
    Actor, Role,
    crypto::{opaque_token, token_hash},
};
use crate::{
    ApiError, ApiResult, AppState,
    events::{Event, emit},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub fn pool(state: &AppState) -> ApiResult<&PgPool> {
    state.postgres.as_ref().ok_or_else(ApiError::unavailable)
}
/// Keep store/member/session write locks in the same order. Event foreign keys also
/// touch the store, so locking sessions first can deadlock recovery or removal.
pub async fn lock_store(conn: &mut PgConnection, id: Uuid) -> ApiResult<()> {
    sqlx::query("SELECT id FROM stores WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
pub fn length(value: &str, min: usize, max: usize) -> ApiResult<()> {
    if (min..=max).contains(&value.chars().count()) {
        Ok(())
    } else {
        Err(ApiError::validation_failed("invalid text length"))
    }
}
#[derive(Clone, Deserialize)]
pub struct Device {
    pub name: String,
    pub platform: String,
    pub app_version: Option<String>,
}
impl Device {
    pub fn validate(&self) -> ApiResult<()> {
        length(&self.name, 0, 60)?;
        if !["android", "ios", "web"].contains(&self.platform.as_str()) {
            return Err(ApiError::validation_failed("invalid platform"));
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
pub struct BankAccount {
    pub bank_bin: String,
    pub account_number: String,
    pub account_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bank_short_name: Option<String>,
}
impl BankAccount {
    pub fn validate(&self) -> ApiResult<()> {
        if self.bank_bin.len() != 6
            || !self.bank_bin.bytes().all(|x| x.is_ascii_digit())
            || !(4..=19).contains(&self.account_number.len())
            || !self
                .account_number
                .bytes()
                .all(|x| x.is_ascii_alphanumeric())
        {
            return Err(ApiError::validation_failed("invalid bank account"));
        }
        length(&self.account_name, 0, 50)
    }
}
#[derive(sqlx::FromRow)]
pub struct StoreRow {
    pub id: Uuid,
    pub name: String,
    pub bank_bin: Option<String>,
    pub bank_short_name: Option<String>,
    pub bank_account_number: Option<String>,
    pub bank_account_name: Option<String>,
    pub margin_threshold_pct: f64,
    pub sales_memo_prefix: String,
    pub created_at: DateTime<Utc>,
    pub version: i64,
}
impl StoreRow {
    pub fn json(&self) -> Value {
        let bank = self.bank_bin.as_ref().map(|bin| {
            json!(BankAccount {
                bank_bin: bin.clone(),
                bank_short_name: self.bank_short_name.clone(),
                account_number: self.bank_account_number.clone().unwrap_or_default(),
                account_name: self.bank_account_name.clone().unwrap_or_default()
            })
        });
        json!({"id":self.id,"name":self.name,"bank_account":bank,"timezone":"Asia/Ho_Chi_Minh","margin_threshold_pct":self.margin_threshold_pct,"sales_memo_prefix":self.sales_memo_prefix,"created_at":self.created_at,"version":self.version})
    }
}
pub const STORE_SELECT: &str = "SELECT id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct::float8 AS margin_threshold_pct,sales_memo_prefix,created_at,version FROM stores WHERE id=$1";
pub async fn store(conn: &mut PgConnection, id: Uuid) -> ApiResult<Value> {
    Ok(sqlx::query_as::<_, StoreRow>(STORE_SELECT)
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::not_found)?
        .json())
}
#[derive(sqlx::FromRow)]
pub struct MemberRow {
    pub id: Uuid,
    pub store_id: Uuid,
    pub display_name: String,
    pub role: String,
    pub can_enroll: bool,
    pub pin_hash: Option<String>,
    pub active: bool,
    pub created_at: DateTime<Utc>,
}
impl MemberRow {
    pub fn json(&self) -> Value {
        json!({"id":self.id,"display_name":self.display_name,"role":self.role,"can_enroll":self.role=="lead"||self.can_enroll,"has_pin":self.pin_hash.is_some(),"active":self.active,"created_at":self.created_at})
    }
}
pub const MEMBER_SELECT: &str = "SELECT id,store_id,display_name,role,can_enroll,pin_hash,active,created_at FROM members WHERE store_id=$1 AND id=$2";
pub async fn member(conn: &mut PgConnection, store_id: Uuid, id: Uuid) -> ApiResult<MemberRow> {
    sqlx::query_as(MEMBER_SELECT)
        .bind(store_id)
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::not_found)
}
pub async fn session_response(
    conn: &mut PgConnection,
    state: &AppState,
    actor: &Actor,
    refresh: &str,
) -> ApiResult<Value> {
    let (access, expires) = state.jwt.issue(actor);
    Ok(
        json!({"access_token":access,"refresh_token":refresh,"expires_in":expires,"member":member(conn,actor.store_id,actor.member_id).await?.json(),"store":store(conn,actor.store_id).await?}),
    )
}
pub async fn new_session(
    conn: &mut PgConnection,
    state: &AppState,
    member: &MemberRow,
    device: &Device,
) -> ApiResult<(Actor, Value)> {
    let actor = Actor {
        member_id: member.id,
        store_id: member.store_id,
        session_id: Uuid::new_v4(),
        role: member.role.parse::<Role>()?,
        can_enroll: member.role == "lead" || member.can_enroll,
    };
    let refresh = opaque_token();
    sqlx::query("INSERT INTO sessions(id,store_id,member_id,device_name,platform,app_version,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '90 days')").bind(actor.session_id).bind(actor.store_id).bind(actor.member_id).bind(&device.name).bind(&device.platform).bind(&device.app_version).bind(token_hash(&refresh)).execute(&mut *conn).await?;
    let response = session_response(conn, state, &actor, &refresh).await?;
    Ok((actor, response))
}
pub async fn member_event(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    change: &'static str,
) -> ApiResult<()> {
    emit(
        conn,
        Event {
            store_id: actor.store_id,
            actor: Some((actor.member_id, actor.session_id)),
            typ: "member.changed",
            version: 1,
            data: json!({"member_id":id,"change":change}),
            change: Some(("member", id, "upsert")),
        },
    )
    .await?;
    Ok(())
}
pub async fn revoked_event(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    reason: &'static str,
) -> ApiResult<()> {
    emit(
        conn,
        Event {
            store_id: actor.store_id,
            actor: Some((actor.member_id, actor.session_id)),
            typ: "session.revoked",
            version: 1,
            data: json!({"session_id":id,"reason":reason}),
            change: None,
        },
    )
    .await?;
    Ok(())
}
