//! Debt book. Customer details belong only in API/feed responses, never telemetry or events.
mod aging;
mod customers;
mod ledger;
mod rows;
pub(crate) use ledger::{lock_customer, record_entry};
pub(crate) use rows::{CustomerRow, DebtEntryRow, load_customers, load_entries};

use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    error::ValidJson,
    idempotency::{Idempotent, check, request_hash},
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
    time::business_date,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        message,
    )
}
// A malformed id names a record that cannot exist. Path<Uuid> would answer with axum's
// plain-text rejection and break the JSON error contract.
fn parse_id(raw: &str) -> ApiResult<Uuid> {
    raw.parse().map_err(|_| ApiError::not_found())
}
// Postgres constraint errors can contain an entire customer row. Log only SQLSTATE.
fn db_error(error: sqlx::Error) -> ApiError {
    let code = error.as_database_error().and_then(|e| e.code());
    tracing::error!(
        sqlstate = code.as_deref().unwrap_or("unknown"),
        "debt database operation failed"
    );
    ApiError::internal()
}
fn validate_profile(
    name: &str,
    phone: Option<&str>,
    note: Option<&str>,
    limit: Option<i64>,
) -> ApiResult<String> {
    let name = name.trim();
    if !(1..=80).contains(&name.chars().count())
        || phone.is_some_and(|s| s.chars().count() > 20)
        || note.is_some_and(|s| s.chars().count() > 200)
        || limit.is_some_and(|n| n < 0)
    {
        return Err(ApiError::validation_failed("invalid customer profile"));
    }
    Ok(name.into())
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/customers",
            get(customers::list).post(customers::create),
        )
        .route(
            "/v1/customers/{id}",
            get(customers::get).patch(customers::patch),
        )
        .route("/v1/customers/{id}/entries", get(entries))
        .route("/v1/customers/{id}/repayments", post(repay))
        .route("/v1/customers/{id}/adjustments", post(adjust))
        .route("/v1/debts/summary", get(customers::summary))
}
#[derive(Deserialize)]
struct Repayment {
    amount: i64,
    method: String,
    #[serde(default, deserialize_with = "device_time")]
    paid_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
struct Adjustment {
    amount: i64,
    reason: String,
    #[serde(default, deserialize_with = "device_time")]
    adjusted_at: Option<DateTime<Utc>>,
}
// Optional device times may be omitted; explicit null is not a date-time in the contract.
fn device_time<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
    DateTime::<Utc>::deserialize(d).map(Some)
}
async fn repay(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<ValidJson<Value>, ApiError>,
) -> ApiResult<Idempotent<Value>> {
    actor.require(Action::RecordDebt)?;
    let id = parse_id(&id)?;
    entry(&state, &actor, id, &headers, body, "repayment").await
}
async fn adjust(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<ValidJson<Value>, ApiError>,
) -> ApiResult<Idempotent<Value>> {
    actor.require(Action::AdjustDebt)?;
    let id = parse_id(&id)?;
    entry(&state, &actor, id, &headers, body, "adjustment").await
}
async fn entry(
    state: &AppState,
    actor: &Actor,
    id: Uuid,
    headers: &HeaderMap,
    body: Result<ValidJson<Value>, ApiError>,
    kind: &str,
) -> ApiResult<Idempotent<Value>> {
    let key = headers
        .get("idempotency-key")
        .and_then(|k| k.to_str().ok())
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| invalid("Idempotency-Key required"))?;
    let ValidJson(raw) = body.map_err(|_| invalid("invalid JSON body"))?;
    if !raw.is_object() {
        return Err(invalid("entry must be an object"));
    }
    let hash = request_hash(&json!({"kind":kind,"body":raw}));
    let key_hash = request_hash(&json!(key));
    let mut tx = pool(state)?.begin().await.map_err(db_error)?;
    // One namespace for both entry operations: keys are unique across the store,
    // even if concurrent requests target different customers or operation types.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("debt-entry:{}:{key}", actor.store_id))
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let saved: Option<(Uuid, Uuid, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT id,customer_id,request_hash FROM debt_entries WHERE store_id=$1 AND key_hash=$2",
    )
    .bind(actor.store_id)
    .bind(key_hash.as_slice())
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    if let Some((entry, customer, stored)) = saved {
        if customer != id {
            return Err(ApiError::conflict(
                "id_conflict",
                "key already used for another customer",
            ));
        }
        check(stored.as_deref().unwrap_or_default(), &hash)?;
        let result = load_entries(&mut tx, actor.store_id, &[entry])
            .await?
            .pop()
            .ok_or_else(ApiError::not_found)?
            .1;
        return Ok(Idempotent::Replay(result));
    }
    let (amount, method, reason, at) = if kind == "repayment" {
        let input: Repayment =
            serde_json::from_value(raw).map_err(|_| invalid("invalid repayment"))?;
        if input.amount < 1 || !matches!(input.method.as_str(), "cash" | "transfer") {
            return Err(invalid("invalid repayment"));
        }
        if input.amount > crate::money::MAX_AMOUNT {
            return Err(invalid(format!(
                "repayment must be at most {} VND",
                crate::money::MAX_AMOUNT
            )));
        }
        (-input.amount, Some(input.method), None, input.paid_at)
    } else {
        let input: Adjustment =
            serde_json::from_value(raw).map_err(|_| invalid("invalid adjustment"))?;
        if input.amount == 0 || !(1..=200).contains(&input.reason.chars().count()) {
            return Err(invalid("invalid adjustment"));
        }
        if input.amount.unsigned_abs() > crate::money::MAX_AMOUNT.unsigned_abs() {
            return Err(invalid(format!(
                "adjustment must be at most {} VND",
                crate::money::MAX_AMOUNT
            )));
        }
        (input.amount, None, Some(input.reason), input.adjusted_at)
    };
    // The client time only picks the day inside the same window as a sale's `sold_at`, and a
    // seller cannot put cash on a day the Lead already closed (it lands today instead). The Lead
    // moving an old paper debt book in dates an adjustment as far back as the books go: overdue
    // tracking depends on the real date. Repayments are cash and keep the window for everyone.
    let now = state.clock.now();
    let booked_at = match at {
        Some(at)
            if kind == "adjustment"
                && actor.role == crate::auth::Role::Lead
                && business_date(at) >= crate::time::EARLIEST_BUSINESS_DATE
                && at <= now + state.sale_window.max_future =>
        {
            at
        }
        Some(at) => crate::sales::bounded_sold_at(&mut tx, state, actor, at).await?,
        None => now,
    };
    let row = record_entry(
        &mut tx,
        actor.store_id,
        id,
        kind,
        amount,
        None,
        method.as_deref(),
        reason.as_deref(),
        actor.member_id,
        business_date(booked_at),
        Some(key_hash.as_slice()),
        Some(hash.as_slice()),
        Some(actor.event_actor()),
    )
    .await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Idempotent::Created(row.json()))
}
async fn entries(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    page: PageParams,
) -> ApiResult<Json<Page<Value>>> {
    actor.require(Action::RecordDebt)?;
    let id = parse_id(&id)?;
    let pool = pool(&state)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE store_id=$1 AND id=$2)")
            .bind(actor.store_id)
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(db_error)?;
    if !exists {
        return Err(ApiError::not_found());
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut rows:Vec<DebtEntryRow>=sqlx::query_as("SELECT * FROM debt_entries WHERE store_id=$1 AND customer_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5")
        .bind(actor.store_id).bind(id).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(i64::from(page.limit)+1).fetch_all(pool).await.map_err(db_error)?;
    let next_cursor = if rows.len() > page.limit as usize {
        rows.pop();
        rows.last()
            .map(|r| encode_cursor(&(r.created_at, r.id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    Ok(Json(Page {
        items: rows.iter().map(DebtEntryRow::json).collect(),
        next_cursor,
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_device_times_reject_null_and_malformed_values() {
        assert!(serde_json::from_value::<Repayment>(json!({"amount":1,"method":"cash"})).is_ok());
        assert!(serde_json::from_value::<Adjustment>(json!({"amount":1,"reason":"x"})).is_ok());
        for at in [Value::Null, json!("bad"), json!(1)] {
            assert!(
                serde_json::from_value::<Repayment>(
                    json!({"amount":1,"method":"cash","paid_at":at})
                )
                .is_err()
            );
            assert!(
                serde_json::from_value::<Adjustment>(
                    json!({"amount":1,"reason":"x","adjusted_at":at})
                )
                .is_err()
            );
        }
    }
    #[test]
    fn customer_validation_bounds_and_trimming() {
        assert_eq!(
            validate_profile("  An  ", None, None, Some(0)).unwrap(),
            "An"
        );
        for name in ["", "  ", &"a".repeat(81)] {
            assert!(validate_profile(name, None, None, None).is_err());
        }
        assert!(
            validate_profile(
                &"é".repeat(80),
                Some(&"1".repeat(20)),
                Some(&"n".repeat(200)),
                None
            )
            .is_ok()
        );
        assert!(validate_profile("A", Some(&"1".repeat(21)), None, None).is_err());
        assert!(validate_profile("A", None, Some(&"n".repeat(201)), None).is_err());
        assert!(validate_profile("A", None, None, Some(-1)).is_err());
    }
}
