use super::{
    db_error, ledger::emit_customer, load_customers, lock_customer, parse_id, rows::CustomerRow,
    validate_profile,
};
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    error::ValidJson,
    idempotency::{Idempotent, check, request_hash},
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
};
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
struct Create {
    id: Uuid,
    name: String,
    phone: Option<String>,
    note: Option<String>,
    credit_limit: Option<i64>,
}
pub(super) async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<Idempotent<Value>> {
    actor.require(Action::RecordDebt)?;
    if !raw.is_object() {
        return Err(ApiError::validation_failed("customer must be an object"));
    }
    let input: Create = serde_json::from_value(raw.clone())
        .map_err(|_| ApiError::validation_failed("invalid customer"))?;
    if input.id.get_version_num() != 7
        || ["phone", "note", "credit_limit"]
            .iter()
            .any(|k| raw.get(k).is_some_and(Value::is_null))
    {
        return Err(ApiError::validation_failed("invalid customer"));
    }
    let name = validate_profile(
        &input.name,
        input.phone.as_deref(),
        input.note.as_deref(),
        input.credit_limit,
    )?;
    let hash = request_hash(&raw);
    let mut tx = pool(&state)?.begin().await.map_err(db_error)?;
    let won=sqlx::query("INSERT INTO customers(id,store_id,name,phone,note,credit_limit,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING")
        .bind(input.id).bind(actor.store_id).bind(name).bind(input.phone).bind(input.note).bind(input.credit_limit).bind(hash.as_slice()).execute(&mut *tx).await.map_err(db_error)?.rows_affected()==1;
    let row: CustomerRow = sqlx::query_as("SELECT * FROM customers WHERE store_id=$1 AND id=$2")
        .bind(actor.store_id)
        .bind(input.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::conflict("id_conflict", "customer id already used"))?;
    if !won {
        check(&row.request_hash, &hash)?;
        return Ok(Idempotent::Replay(row.json(state.clock.today())));
    }
    emit_customer(
        &mut tx,
        actor.store_id,
        Some(actor.event_actor()),
        "customer.created",
        row.id,
        row.balance,
        false,
    )
    .await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Idempotent::Created(row.json(state.clock.today())))
}
pub(super) async fn get(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::RecordDebt)?;
    let id = parse_id(&id)?;
    let mut conn = pool(&state)?.acquire().await.map_err(db_error)?;
    Ok(Json(
        load_customers(&mut conn, actor.store_id, &[id], state.clock.today())
            .await?
            .pop()
            .ok_or_else(ApiError::not_found)?
            .1,
    ))
}
fn optional_string(raw: &Value, key: &str, previous: Option<String>) -> ApiResult<Option<String>> {
    match raw.get(key) {
        None => Ok(previous),
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(ApiError::validation_failed("invalid customer profile")),
    }
}
pub(super) async fn patch(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::RecordDebt)?;
    let id = parse_id(&id)?;
    if !raw.is_object() {
        return Err(ApiError::validation_failed("invalid customer patch"));
    }
    let mut tx = pool(&state)?.begin().await.map_err(db_error)?;
    let mut row = lock_customer(&mut tx, actor.store_id, id).await?;
    let archived = match raw.get("archived") {
        None => row.archived_at.is_some(),
        Some(Value::Bool(v)) => *v,
        _ => return Err(ApiError::validation_failed("invalid archived flag")),
    };
    if archived != row.archived_at.is_some() {
        actor.require(Action::AdjustDebt)?;
    }
    if let Some(value) = raw.get("name") {
        row.name = value
            .as_str()
            .ok_or_else(|| ApiError::validation_failed("invalid customer name"))?
            .into();
    }
    row.phone = optional_string(&raw, "phone", row.phone)?;
    row.note = optional_string(&raw, "note", row.note)?;
    if let Some(value) = raw.get("credit_limit") {
        row.credit_limit = if value.is_null() {
            None
        } else {
            Some(
                value
                    .as_i64()
                    .ok_or_else(|| ApiError::validation_failed("invalid credit limit"))?,
            )
        };
    }
    row.name = validate_profile(
        &row.name,
        row.phone.as_deref(),
        row.note.as_deref(),
        row.credit_limit,
    )?;
    sqlx::query("UPDATE customers SET name=$3,phone=$4,note=$5,credit_limit=$6,archived_at=CASE WHEN $7 THEN coalesce(archived_at,clock_timestamp()) ELSE NULL END,updated_at=clock_timestamp() WHERE store_id=$1 AND id=$2")
        .bind(actor.store_id).bind(id).bind(row.name).bind(row.phone).bind(row.note).bind(row.credit_limit).bind(archived).execute(&mut *tx).await.map_err(db_error)?;
    emit_customer(
        &mut tx,
        actor.store_id,
        Some(actor.event_actor()),
        "customer.updated",
        id,
        row.balance,
        archived,
    )
    .await?;
    let result = load_customers(&mut tx, actor.store_id, &[id], state.clock.today())
        .await?
        .pop()
        .ok_or_else(ApiError::not_found)?
        .1;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}
#[derive(Default, Deserialize)]
pub(super) struct Filters {
    query: Option<String>,
    overdue: Option<bool>,
    archived: Option<bool>,
    sort: Option<String>,
}
// Cursor carries the ordering value and sort, so changing sort cannot reinterpret it.
#[derive(Deserialize, serde::Serialize)]
struct Cursor {
    sort: String,
    balance: i64,
    recent: DateTime<Utc>,
    name: String,
    id: Uuid,
}
#[derive(sqlx::FromRow)]
struct ListRow {
    #[sqlx(flatten)]
    customer: CustomerRow,
    sort_name: String,
}
pub(super) async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
    filters: Result<Query<Filters>, QueryRejection>,
) -> ApiResult<Json<Page<Value>>> {
    actor.require(Action::RecordDebt)?;
    let f = filters
        .map_err(|_| ApiError::validation_failed("invalid customer filters"))?
        .0;
    let sort = f.sort.as_deref().unwrap_or("balance");
    if !matches!(sort, "balance" | "recent" | "name") {
        return Err(ApiError::validation_failed("invalid customer sort"));
    }
    let cursor: Option<Cursor> = page.cursor.as_deref().map(decode_cursor).transpose()?;
    if cursor.as_ref().is_some_and(|c| c.sort != sort) {
        return Err(ApiError::bad_request(
            "invalid_cursor",
            "cursor sort mismatch",
        ));
    }
    let today = state.clock.today();
    let mut rows:Vec<ListRow>=sqlx::query_as("SELECT *,lower(name) AS sort_name FROM customers WHERE store_id=$1 AND (archived_at IS NOT NULL)=$2 AND ($3::text IS NULL OR strpos(lower(name),lower($3))>0 OR strpos(lower(coalesce(phone,'')),lower($3))>0) AND ($4::bool IS NULL OR coalesce(oldest_debt_date < $5::date - 7,false)=$4) AND ($6::uuid IS NULL OR ($7='balance' AND (balance < $8 OR (balance=$8 AND id>$6))) OR ($7='recent' AND (updated_at < $9 OR (updated_at=$9 AND id>$6))) OR ($7='name' AND (lower(name),id)>($10,$6))) ORDER BY CASE WHEN $7='balance' THEN balance END DESC, CASE WHEN $7='recent' THEN updated_at END DESC, CASE WHEN $7='name' THEN lower(name) END, id LIMIT $11")
        .bind(actor.store_id).bind(f.archived.unwrap_or(false)).bind(f.query.as_deref()).bind(f.overdue).bind(today)
        .bind(cursor.as_ref().map(|c|c.id)).bind(sort).bind(cursor.as_ref().map(|c|c.balance)).bind(cursor.as_ref().map(|c|c.recent)).bind(cursor.as_ref().map(|c|c.name.as_str())).bind(i64::from(page.limit)+1)
        .fetch_all(pool(&state)?).await.map_err(db_error)?;
    // Use PostgreSQL's lower() value for cursors too (Unicode case mapping can differ from Rust).
    let next_cursor = if rows.len() > page.limit as usize {
        rows.pop();
        if let Some(r) = rows.last() {
            Some(
                encode_cursor(&Cursor {
                    sort: sort.into(),
                    balance: r.customer.balance,
                    recent: r.customer.updated_at,
                    name: r.sort_name.clone(),
                    id: r.customer.id,
                })
                .map_err(|_| ApiError::internal())?,
            )
        } else {
            None
        }
    } else {
        None
    };
    Ok(Json(Page {
        items: rows.iter().map(|r| r.customer.json(today)).collect(),
        next_cursor,
    }))
}
pub(super) async fn summary(State(state): State<AppState>, actor: Actor) -> ApiResult<Json<Value>> {
    actor.require(Action::RecordDebt)?;
    let today: NaiveDate = state.clock.today();
    // One snapshot makes aggregates and the top-five list agree during concurrent repayments.
    let mut tx = pool(&state)?.begin().await.map_err(db_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let (total,count,overdue_count,overdue_amount):(i64,i64,i64,i64)=sqlx::query_as("SELECT coalesce(sum(balance),0)::bigint,count(*),count(*) FILTER(WHERE oldest_debt_date < $2::date - 7),coalesce(sum(balance) FILTER(WHERE oldest_debt_date < $2::date - 7),0)::bigint FROM customers WHERE store_id=$1 AND balance>0")
        .bind(actor.store_id).bind(today).fetch_one(&mut *tx).await.map_err(db_error)?;
    let top: Vec<CustomerRow> = sqlx::query_as(
        "SELECT * FROM customers WHERE store_id=$1 AND balance>0 ORDER BY balance DESC,id LIMIT 5",
    )
    .bind(actor.store_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(
        json!({"total_outstanding":total,"customers_with_debt":count,"overdue_count":overdue_count,"overdue_amount":overdue_amount,"top_debtors":top.iter().map(|r|r.json(today)).collect::<Vec<_>>()}),
    ))
}
