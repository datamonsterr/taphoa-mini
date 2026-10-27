//! Expenses and stock purchases. Every purchase side effect shares the expense transaction.
mod alerts;
#[cfg(test)]
mod tests;

use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor},
    error::ValidJson,
    events::{Event, emit},
    idempotency::{self, Idempotent, request_hash},
    money,
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
    time::business_date,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/expenses", get(list).post(create))
        .route(
            "/v1/expenses/{id}",
            get(detail).patch(update).delete(delete),
        )
        .route("/v1/alerts", get(alerts::list))
        .route("/v1/alerts/{id}/accept", post(alerts::accept))
        .route("/v1/alerts/{id}/dismiss", post(alerts::dismiss))
}
fn pool(state: &AppState) -> ApiResult<&PgPool> {
    state.postgres.as_ref().ok_or_else(ApiError::unavailable)
}
fn invalid(message: &str) -> ApiError {
    ApiError::validation_failed(message)
}
fn category(value: &str) -> ApiResult<()> {
    if ["nhap_hang", "dien", "nuoc", "khac"].contains(&value) {
        Ok(())
    } else {
        Err(invalid("invalid expense category"))
    }
}
fn note(value: Option<&str>) -> ApiResult<()> {
    if value.is_some_and(|s| s.chars().count() > 500) {
        Err(invalid("note exceeds 500 characters"))
    } else {
        Ok(())
    }
}
fn id(value: &str) -> ApiResult<Uuid> {
    value.parse().map_err(|_| invalid("invalid id"))
}
#[derive(Debug, Deserialize, Serialize, sqlx::FromRow)]
pub(crate) struct PurchaseLine {
    pub(crate) product_id: Uuid,
    pub(crate) unit_id: Option<Uuid>,
    pub(crate) quantity: i32,
    pub(crate) unit_cost: i64,
}
#[derive(Deserialize)]
pub(crate) struct CreateExpense {
    pub(crate) id: Uuid,
    pub(crate) spent_at: DateTime<Utc>,
    pub(crate) amount: i64,
    pub(crate) category: String,
    pub(crate) paid_with: String,
    pub(crate) image_id: Option<Uuid>,
    pub(crate) note: Option<String>,
    #[serde(default)]
    pub(crate) purchase_lines: Vec<PurchaseLine>,
}
impl CreateExpense {
    fn validate(&self) -> ApiResult<()> {
        if self.amount <= 0 {
            return Err(invalid("amount must be positive"));
        }
        category(&self.category)?;
        note(self.note.as_deref())?;
        if !["cash_box", "other"].contains(&self.paid_with.as_str()) {
            return Err(invalid("invalid paid_with"));
        }
        if !self.purchase_lines.is_empty() {
            if self.category != "nhap_hang" {
                return Err(invalid("purchase lines require nhap_hang"));
            }
            if self
                .purchase_lines
                .iter()
                .any(|line| line.quantity <= 0 || line.unit_cost < 0)
            {
                return Err(invalid("invalid purchase quantity or cost"));
            }
            let lines: Vec<_> = self
                .purchase_lines
                .iter()
                .map(|line| (line.quantity, line.unit_cost))
                .collect();
            let total = money::sum_lines(&lines);
            if total != Some(self.amount) {
                return Err(invalid("amount must equal purchase line sum"));
            }
        }
        Ok(())
    }
}
#[derive(sqlx::FromRow)]
struct ExpenseRow {
    id: Uuid,
    member_id: Uuid,
    spent_at: DateTime<Utc>,
    business_date: NaiveDate,
    amount: i64,
    category: String,
    paid_with: String,
    image_id: Option<Uuid>,
    note: Option<String>,
    created_at: DateTime<Utc>,
}
async fn load(conn: &mut PgConnection, store: Uuid, id: Uuid) -> ApiResult<ExpenseRow> {
    sqlx::query_as(
        "SELECT * FROM expenses WHERE store_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(store)
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(ApiError::not_found)
}
async fn image_owned(conn: &mut PgConnection, store: Uuid, image: Option<Uuid>) -> ApiResult<()> {
    if let Some(image) = image {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM images WHERE store_id=$1 AND id=$2)")
                .bind(store)
                .bind(image)
                .fetch_one(conn)
                .await?;
        if !exists {
            return Err(ApiError::not_found());
        }
    }
    Ok(())
}
async fn response(
    conn: &mut PgConnection,
    state: &AppState,
    actor: &Actor,
    row: ExpenseRow,
) -> ApiResult<Value> {
    let lines: Vec<PurchaseLine> = sqlx::query_as("SELECT product_id,unit_id,quantity,unit_cost FROM purchase_lines WHERE store_id=$1 AND expense_id=$2 ORDER BY id")
        .bind(actor.store_id).bind(row.id).fetch_all(&mut *conn).await?;
    let raised = alerts::for_expense(conn, actor.store_id, row.id).await?;
    let mut result = json!({"id":row.id,"spent_at":row.spent_at,"amount":row.amount,
        "category":row.category,"paid_with":row.paid_with,"business_date":row.business_date,
        "member_id":row.member_id,"created_at":row.created_at,"purchase_lines":lines,"alerts":raised,"image":null});
    // The inherited CreateExpenseRequest schema permits omission, but not null, for these fields.
    if let Some(note) = row.note {
        result["note"] = json!(note);
    }
    if let Some(image) = row.image_id {
        let image_response =
            crate::images::get_image(State(state.clone()), actor.clone(), Path(image.to_string()))
                .await?;
        result["image_id"] = json!(image);
        result["image"] =
            serde_json::to_value(image_response.0).map_err(|_| ApiError::internal())?;
    }
    Ok(result)
}
async fn event(
    conn: &mut PgConnection,
    actor: &Actor,
    typ: &'static str,
    data: Value,
) -> ApiResult<()> {
    emit(
        conn,
        Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ,
            version: 1,
            data,
            change: None,
        },
    )
    .await?;
    Ok(())
}
async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<Idempotent<Value>> {
    actor.require(Action::AddExpense)?;
    let hash = request_hash(&raw);
    let input: CreateExpense =
        serde_json::from_value(raw).map_err(|_| invalid("invalid expense"))?;
    input.validate()?;
    let mut tx = pool(&state)?.begin().await?;
    let inserted = create_in_transaction(&mut tx, &actor, &input, &hash).await?;
    if !inserted {
        let stored: Vec<u8> =
            sqlx::query_scalar("SELECT request_hash FROM expenses WHERE store_id=$1 AND id=$2")
                .bind(actor.store_id)
                .bind(input.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(ApiError::not_found)?;
        idempotency::check(&stored, &hash)?;
        let row = sqlx::query_as("SELECT * FROM expenses WHERE store_id=$1 AND id=$2")
            .bind(actor.store_id)
            .bind(input.id)
            .fetch_one(&mut *tx)
            .await?;
        let result = response(&mut tx, &state, &actor, row).await?;
        tx.commit().await?;
        return Ok(Idempotent::Replay(result));
    }
    let row = load(&mut tx, actor.store_id, input.id).await?;
    let result = response(&mut tx, &state, &actor, row).await?;
    tx.commit().await?;
    Ok(Idempotent::Created(result))
}
/// Create an expense and every purchase side effect in a caller-owned transaction.
/// Callers validate their input and lock the complete product set before any event.
/// Receipt callers preserve sum(line cost) even when ceil(unit cost) rounds up.
pub(crate) async fn create_in_transaction(
    conn: &mut PgConnection,
    actor: &Actor,
    input: &CreateExpense,
    hash: &[u8; 32],
) -> ApiResult<bool> {
    // ON CONFLICT waits for an in-flight identical create before checking its committed hash.
    // Store-scoped lookup below hides another store's use of the same client id.
    let inserted = sqlx::query("INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,image_id,note,request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10) ON CONFLICT (id) DO NOTHING")
        .bind(input.id).bind(actor.store_id).bind(actor.member_id).bind(input.spent_at)
        .bind(business_date(input.spent_at)).bind(input.amount).bind(&input.category)
        .bind(&input.paid_with).bind(&input.note).bind(hash.as_slice()).execute(&mut *conn).await?.rows_affected() == 1;
    if !inserted {
        return Ok(false);
    }
    image_owned(conn, actor.store_id, input.image_id).await?;
    if let Some(image) = input.image_id {
        sqlx::query("UPDATE expenses SET image_id=$2 WHERE id=$1")
            .bind(input.id)
            .bind(image)
            .execute(&mut *conn)
            .await?;
    }
    // Consistent product lock order also serializes purchases against alert acceptance.
    let product_ids: Vec<Uuid> = input
        .purchase_lines
        .iter()
        .map(|line| line.product_id)
        .collect();
    sqlx::query("SELECT id FROM products WHERE store_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE")
        .bind(actor.store_id)
        .bind(&product_ids)
        .fetch_all(&mut *conn)
        .await?;
    let threshold: i64 =
        sqlx::query_scalar("SELECT (margin_threshold_pct*100)::bigint FROM stores WHERE id=$1")
            .bind(actor.store_id)
            .fetch_one(&mut *conn)
            .await?;
    for line in &input.purchase_lines {
        let (price, old_cost): (i64, Option<i64>) =
            sqlx::query_as("SELECT price,cost_price FROM products WHERE store_id=$1 AND id=$2")
                .bind(actor.store_id)
                .bind(line.product_id)
                .fetch_optional(&mut *conn)
                .await?
                .ok_or_else(ApiError::not_found)?;
        let quantity = if let Some(unit) = line.unit_id {
            sqlx::query_scalar::<_, i32>("SELECT quantity_in_base FROM product_units WHERE store_id=$1 AND product_id=$2 AND id=$3")
                .bind(actor.store_id).bind(line.product_id).bind(unit).fetch_optional(&mut *conn).await?.ok_or_else(ApiError::not_found)?
        } else {
            1
        };
        let cost = money::base_unit_cost(line.unit_cost, quantity);
        sqlx::query("INSERT INTO purchase_lines (store_id,expense_id,product_id,unit_id,quantity,unit_cost,base_unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)")
            .bind(actor.store_id).bind(input.id).bind(line.product_id).bind(line.unit_id).bind(line.quantity).bind(line.unit_cost).bind(cost).execute(&mut *conn).await?;
        sqlx::query("UPDATE products SET cost_price=$3,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2")
            .bind(actor.store_id).bind(line.product_id).bind(cost).execute(&mut *conn).await?;
        sqlx::query("INSERT INTO price_history (store_id,product_id,field,old_value,new_value,source,changed_by) VALUES ($1,$2,'cost_price',$3,$4,'purchase',$5)")
            .bind(actor.store_id).bind(line.product_id).bind(old_cost).bind(cost).bind(actor.member_id).execute(&mut *conn).await?;
        alerts::purchase(
            conn,
            actor,
            input.id,
            line.product_id,
            price,
            cost,
            threshold,
        )
        .await?;
    }
    event(conn, actor, "expense.created", json!({"expense_id":input.id,"amount":input.amount,"category":input.category,"business_date":business_date(input.spent_at)})).await?;
    Ok(true)
}
#[derive(Deserialize)]
struct Filters {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    category: Option<String>,
}
async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
    filters: Result<Query<Filters>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<Json<Page<Value>>> {
    actor.require(Action::AddExpense)?;
    let Query(filters) = filters.map_err(|_| invalid("invalid expense filters"))?;
    if let Some(value) = &filters.category {
        category(value)?;
    }
    if filters
        .from
        .zip(filters.to)
        .is_some_and(|(from, to)| from > to)
    {
        return Err(invalid("from must not follow to"));
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut conn = pool(&state)?.acquire().await?;
    let mut rows: Vec<ExpenseRow> = sqlx::query_as("SELECT * FROM expenses WHERE store_id=$1 AND deleted_at IS NULL AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3) AND ($4::text IS NULL OR category=$4) AND ($5::timestamptz IS NULL OR (spent_at,id)<($5,$6)) ORDER BY spent_at DESC,id DESC LIMIT $7")
        .bind(actor.store_id).bind(filters.from).bind(filters.to).bind(filters.category)
        .bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(i64::from(page.limit)+1).fetch_all(&mut *conn).await?;
    let more = rows.len() > page.limit as usize;
    rows.truncate(page.limit as usize);
    let next_cursor = if more {
        rows.last()
            .map(|r| encode_cursor(&(r.spent_at, r.id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(response(&mut conn, &state, &actor, row).await?);
    }
    Ok(Json(Page { items, next_cursor }))
}
async fn detail(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::AddExpense)?;
    let mut conn = pool(&state)?.acquire().await?;
    let row = load(&mut conn, actor.store_id, id(&raw_id)?).await?;
    Ok(Json(response(&mut conn, &state, &actor, row).await?))
}
async fn update(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
    ValidJson(patch): ValidJson<Value>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::AddExpense)?;
    let patch = patch
        .as_object()
        .ok_or_else(|| invalid("expected patch object"))?;
    if patch.contains_key("purchase_lines") {
        return Err(invalid("purchase lines are immutable"));
    }
    let mut tx = pool(&state)?.begin().await?;
    let mut row = load(&mut tx, actor.store_id, id(&raw_id)?).await?;
    if row.member_id != actor.member_id {
        actor.require(Action::EditAnyExpense)?;
    }
    let original_amount = row.amount;
    if let Some(value) = patch.get("amount") {
        row.amount = value
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid("amount must be positive"))?;
    }
    if let Some(value) = patch.get("category") {
        row.category = value
            .as_str()
            .ok_or_else(|| invalid("invalid category"))?
            .to_owned();
        category(&row.category)?;
    }
    let has_lines: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM purchase_lines WHERE store_id=$1 AND expense_id=$2)",
    )
    .bind(actor.store_id)
    .bind(row.id)
    .fetch_one(&mut *tx)
    .await?;
    if has_lines && (row.amount != original_amount || row.category != "nhap_hang") {
        return Err(invalid("purchase amount and category are immutable"));
    }
    if let Some(value) = patch.get("note") {
        row.note = if value.is_null() {
            None
        } else {
            Some(
                value
                    .as_str()
                    .ok_or_else(|| invalid("invalid note"))?
                    .to_owned(),
            )
        };
        note(row.note.as_deref())?;
    }
    if let Some(value) = patch.get("image_id") {
        row.image_id = if value.is_null() {
            None
        } else {
            Some(id(value
                .as_str()
                .ok_or_else(|| invalid("invalid image id"))?)?)
        };
        image_owned(&mut tx, actor.store_id, row.image_id).await?;
    }
    sqlx::query("UPDATE expenses SET amount=$3,category=$4,note=$5,image_id=$6,updated_at=now() WHERE store_id=$1 AND id=$2")
        .bind(actor.store_id).bind(row.id).bind(row.amount).bind(&row.category).bind(&row.note).bind(row.image_id).execute(&mut *tx).await?;
    let result = response(&mut tx, &state, &actor, row).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn delete(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
) -> ApiResult<StatusCode> {
    actor.require(Action::EditAnyExpense)?;
    let changed = sqlx::query("UPDATE expenses SET deleted_at=now(),updated_at=now() WHERE store_id=$1 AND id=$2 AND deleted_at IS NULL")
        .bind(actor.store_id).bind(id(&raw_id)?).execute(pool(&state)?).await?.rows_affected();
    if changed == 0 {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}
