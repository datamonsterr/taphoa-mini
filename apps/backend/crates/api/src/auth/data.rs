use super::Actor;
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
/// Lock the parent before membership writes and event publication.
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
    pub low_stock_threshold: i32,
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
        json!({"id":self.id,"name":self.name,"bank_account":bank,"timezone":"Asia/Ho_Chi_Minh","margin_threshold_pct":self.margin_threshold_pct,"sales_memo_prefix":self.sales_memo_prefix,"low_stock_threshold":self.low_stock_threshold,"created_at":self.created_at,"version":self.version})
    }
}
pub const STORE_SELECT: &str = "SELECT id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct::float8 AS margin_threshold_pct,sales_memo_prefix,low_stock_threshold,created_at,version FROM stores WHERE id=$1";
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
            actor: Some(actor.event_actor()),
            typ: "member.changed",
            version: 1,
            data: json!({"member_id":id,"change":change}),
            change: Some(("member", id, "upsert")),
        },
    )
    .await?;
    Ok(())
}
