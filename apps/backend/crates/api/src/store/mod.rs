use crate::{
    ApiError, ApiResult, AppState,
    auth::{
        Action, Actor, Role,
        crypto::{invite_token, token_hash},
        data::*,
    },
    error::ValidJson,
    events::{Event, emit},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/store", get(get_store).patch(patch_store))
        .route("/v1/members", get(members))
        .route(
            "/v1/members/{id}",
            patch(patch_member).delete(remove_member),
        )
        .route("/v1/invites", post(invite))
}
fn object(input: &Value) -> ApiResult<&serde_json::Map<String, Value>> {
    input
        .as_object()
        .ok_or_else(|| ApiError::validation_failed("expected an object"))
}
fn text(value: &Value, min: usize, max: usize) -> ApiResult<&str> {
    let value = value
        .as_str()
        .ok_or_else(|| ApiError::validation_failed("expected a string"))?;
    length(value, min, max)?;
    Ok(value)
}
fn boolean(value: &Value) -> ApiResult<bool> {
    value
        .as_bool()
        .ok_or_else(|| ApiError::validation_failed("expected a boolean"))
}
pub async fn get_store(State(state): State<AppState>, actor: Actor) -> ApiResult<Json<Value>> {
    let mut conn = pool(&state)?.acquire().await?;
    Ok(Json(store(&mut conn, actor.store_id).await?))
}
async fn patch_store(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(input): ValidJson<Value>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::ManageStore)?;
    let patch = object(&input)?;
    let mut tx = pool(&state)?.begin().await?;
    let row: StoreRow = sqlx::query_as("SELECT id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct::float8 AS margin_threshold_pct,sales_memo_prefix,low_stock_threshold,created_at,version FROM stores WHERE id=$1 FOR UPDATE")
        .bind(actor.store_id)
        .fetch_one(&mut *tx)
        .await?;
    let mut current = row.json();
    let mut fields = Vec::new();
    for field in [
        "name",
        "margin_threshold_pct",
        "sales_memo_prefix",
        "low_stock_threshold",
    ] {
        if let Some(value) = patch.get(field) {
            match field {
                "name" => {
                    text(value, 1, 80)?;
                }
                "sales_memo_prefix" => {
                    text(value, 0, 8)?;
                }
                "low_stock_threshold" => {
                    if !value.as_i64().is_some_and(|n| (0..=100000).contains(&n)) {
                        return Err(ApiError::validation_failed("invalid low stock threshold"));
                    }
                }
                _ => {
                    if !value.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n)) {
                        return Err(ApiError::validation_failed("invalid margin threshold"));
                    }
                }
            }
            if current[field] != *value {
                current[field] = value.clone();
                fields.push(field);
            }
        }
    }
    if let Some(value) = patch.get("bank_account") {
        let bank = if value.is_null() {
            Value::Null
        } else {
            let patch = object(value)?;
            let mut merged = current["bank_account"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            for (key, value) in patch {
                if value.is_null() {
                    merged.remove(key);
                } else {
                    merged.insert(key.clone(), value.clone());
                }
            }
            let bank: BankAccount = serde_json::from_value(Value::Object(merged))
                .map_err(|_| ApiError::validation_failed("invalid bank account"))?;
            bank.validate()?;
            json!(bank)
        };
        if current["bank_account"] != bank {
            current["bank_account"] = bank;
            fields.push("bank_account");
        }
    }
    if !fields.is_empty() {
        let bank: Option<BankAccount> = serde_json::from_value(current["bank_account"].clone())
            .map_err(|_| ApiError::validation_failed("invalid bank account"))?;
        sqlx::query("UPDATE stores SET name=$2,bank_bin=$3,bank_short_name=$4,bank_account_number=$5,bank_account_name=$6,margin_threshold_pct=$7::float8::numeric,sales_memo_prefix=$8,low_stock_threshold=$9,version=version+1,updated_at=now() WHERE id=$1")
            .bind(actor.store_id).bind(current["name"].as_str()).bind(bank.as_ref().map(|b|&b.bank_bin)).bind(bank.as_ref().and_then(|b|b.bank_short_name.as_ref())).bind(bank.as_ref().map(|b|&b.account_number)).bind(bank.as_ref().map(|b|&b.account_name)).bind(current["margin_threshold_pct"].as_f64()).bind(current["sales_memo_prefix"].as_str()).bind(current["low_stock_threshold"].as_i64().map(|n|n as i32)).execute(&mut *tx).await?;
        emit(
            &mut tx,
            Event {
                store_id: actor.store_id,
                actor: Some((actor.member_id, actor.session_id)),
                typ: "store.changed",
                version: 1,
                data: json!({"fields":fields}),
                change: Some(("store", actor.store_id, "upsert")),
            },
        )
        .await?;
    }
    let result = store(&mut tx, actor.store_id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn members(State(state): State<AppState>, actor: Actor) -> ApiResult<Json<Value>> {
    let rows:Vec<MemberRow>=sqlx::query_as("SELECT id,store_id,display_name,role,can_enroll,pin_hash,active,created_at FROM members WHERE store_id=$1 ORDER BY active DESC,created_at,id").bind(actor.store_id).fetch_all(pool(&state)?).await?;
    Ok(Json(
        json!({"items":rows.iter().map(MemberRow::json).collect::<Vec<_>>()}),
    ))
}
async fn lock_leads(conn: &mut sqlx::PgConnection, store_id: Uuid) -> ApiResult<Vec<Uuid>> {
    // The parent row serializes promotions too, including stores with a single Lead.
    sqlx::query("SELECT id FROM stores WHERE id=$1 FOR UPDATE")
        .bind(store_id)
        .execute(&mut *conn)
        .await?;
    Ok(sqlx::query_scalar("SELECT id FROM members WHERE store_id=$1 AND role='lead' AND active ORDER BY id FOR UPDATE").bind(store_id).fetch_all(conn).await?)
}
fn keep_lead(leads: &[Uuid], member: &MemberRow, demote: bool) -> ApiResult<()> {
    if demote && member.active && member.role == "lead" && leads.len() <= 1 {
        Err(ApiError::conflict(
            "last_lead",
            "store must keep an active Lead",
        ))
    } else {
        Ok(())
    }
}
async fn patch_member(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ValidJson(input): ValidJson<Value>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::ManageMembers)?;
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::validation_failed("invalid member id"))?;
    let patch = object(&input)?;
    let name = patch
        .get("display_name")
        .map(|v| text(v, 1, 40))
        .transpose()?;
    let role = patch
        .get("role")
        .map(|v| text(v, 1, 6).and_then(str::parse::<Role>))
        .transpose()?;
    let enroll = patch.get("can_enroll").map(boolean).transpose()?;
    let mut tx = pool(&state)?.begin().await?;
    let leads = lock_leads(&mut tx, actor.store_id).await?;
    let member = member(&mut tx, actor.store_id, id).await?;
    keep_lead(&leads, &member, role == Some(Role::Seller))?;
    let role = role.map(Role::as_str).unwrap_or(&member.role);
    let enroll = role == "lead" || enroll.unwrap_or(member.can_enroll);
    let name = name.unwrap_or(&member.display_name);
    if role != member.role || enroll != member.can_enroll || name != member.display_name {
        sqlx::query("UPDATE members SET display_name=$3,role=$4,can_enroll=$5,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2").bind(actor.store_id).bind(id).bind(name).bind(role).bind(enroll).execute(&mut *tx).await?;
        member_event(&mut tx, &actor, id, "updated").await?;
    }
    let result = crate::auth::data::member(&mut tx, actor.store_id, id)
        .await?
        .json();
    tx.commit().await?;
    Ok(Json(result))
}
async fn remove_member(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    actor.require(Action::ManageMembers)?;
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::validation_failed("invalid member id"))?;
    let mut tx = pool(&state)?.begin().await?;
    let leads = lock_leads(&mut tx, actor.store_id).await?;
    let member = member(&mut tx, actor.store_id, id).await?;
    keep_lead(&leads, &member, true)?;
    if member.active {
        sqlx::query("UPDATE members SET active=false,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2").bind(actor.store_id).bind(id).execute(&mut *tx).await?;
        let sessions:Vec<Uuid>=sqlx::query_scalar("UPDATE sessions SET revoked_at=now() WHERE store_id=$1 AND member_id=$2 AND revoked_at IS NULL RETURNING id").bind(actor.store_id).bind(id).fetch_all(&mut *tx).await?;
        for sid in sessions {
            revoked_event(&mut tx, &actor, sid, "member_removed").await?;
        }
        member_event(&mut tx, &actor, id, "deactivated").await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct InviteInput {
    role: Option<Role>,
    #[serde(default)]
    can_enroll: bool,
    ttl_seconds: Option<i64>,
}
async fn invite(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(input): ValidJson<InviteInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    actor.require(Action::ManageInvites)?;
    let role = input.role.unwrap_or(Role::Seller);
    let ttl = input.ttl_seconds.unwrap_or(600);
    if !(60..=86400).contains(&ttl) {
        return Err(ApiError::validation_failed(
            "invite TTL must be 60 to 86400 seconds",
        ));
    }
    let token = invite_token();
    let enroll = input.can_enroll;
    let mut tx = pool(&state)?.begin().await?;
    let expires:chrono::DateTime<chrono::Utc>=sqlx::query_scalar("INSERT INTO invites(store_id,token_hash,role,can_enroll,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second') RETURNING expires_at").bind(actor.store_id).bind(token_hash(&token)).bind(role.as_str()).bind(enroll).bind(actor.member_id).bind(ttl as f64).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(
            json!({"token":token,"join_url":format!("taphoa://join?token={token}"),"role":role,"can_enroll":enroll,"expires_at":expires}),
        ),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_names_bank_and_patch_types() {
        assert!(length("", 1, 80).is_err());
        assert!(length(&"ạ".repeat(80), 1, 80).is_ok());
        for bank in [
            json!({"bank_bin":"12345","account_number":"1234","account_name":"A"}),
            json!({"bank_bin":"123456","account_number":"a_12","account_name":"A"}),
            json!({"bank_bin":"123456","account_number":"1234","account_name":"A".repeat(51)}),
        ] {
            assert!(
                serde_json::from_value::<BankAccount>(bank)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        assert!(boolean(&Value::Null).is_err());
        assert!(object(&json!([])).is_err());
    }
}
