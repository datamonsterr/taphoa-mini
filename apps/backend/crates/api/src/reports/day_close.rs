//! Persisted cash-count snapshots, with late sales calculated when read.
use super::query;
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    error::ValidJson,
    events::{Event, emit},
    money,
};
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::StatusCode,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Serialize, sqlx::FromRow)]
struct Close {
    business_date: NaiveDate,
    opening_float: i64,
    cash_sales: i64,
    cash_refunds: i64,
    cash_repayments: i64,
    transfer_repayments: i64,
    credit_sales: i64,
    cash_expenses: i64,
    expected_cash: i64,
    counted_cash: i64,
    difference: i64,
    transfer_revenue: i64,
    note: Option<String>,
    closed_by: Uuid,
    closed_at: DateTime<Utc>,
    late_sales_count: i64,
}
const SELECT: &str = r#"
    SELECT c.*, (SELECT count(*) FROM sales s WHERE s.store_id=c.store_id
        AND s.business_date=c.business_date AND s.status='completed'
        AND s.received_at>c.closed_at)
        + (SELECT count(*) FROM debt_entries d WHERE d.store_id=c.store_id
        AND d.business_date=c.business_date AND d.kind='repayment'
        AND d.created_at>c.closed_at) late_sales_count
    FROM day_closes c
    WHERE c.store_id=$1 AND ($2::date IS NULL OR c.business_date >= $2)
        AND ($3::date IS NULL OR c.business_date <= $3)
    ORDER BY c.business_date DESC
"#;
fn date(raw: &str) -> ApiResult<NaiveDate> {
    raw.parse()
        .map_err(|_| ApiError::validation_failed("invalid business date"))
}
#[derive(Deserialize)]
pub(super) struct Filters {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}
pub(super) async fn list(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<Filters>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::DayClose)?;
    let p = query(params)?;
    if p.from.zip(p.to).is_some_and(|(from, to)| from > to) {
        return Err(ApiError::validation_failed("from must not follow to"));
    }
    let rows: Vec<Close> = sqlx::query_as(SELECT)
        .bind(actor.store_id)
        .bind(p.from)
        .bind(p.to)
        .fetch_all(pool(&state)?)
        .await?;
    Ok(Json(json!({"items":rows})))
}
pub(super) async fn get(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw): Path<String>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::DayClose)?;
    let day = date(&raw)?;
    let row: Close = sqlx::query_as(SELECT)
        .bind(actor.store_id)
        .bind(day)
        .bind(day)
        .fetch_optional(pool(&state)?)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(Json(json!(row)))
}
#[derive(Deserialize)]
pub(super) struct Input {
    counted_cash: i64,
    #[serde(default)]
    opening_float: i64,
    note: Option<String>,
}
#[derive(sqlx::FromRow)]
struct Cash {
    cash_sales: i64,
    cash_refunds: i64,
    cash_repayments: i64,
    transfer_repayments: i64,
    credit_sales: i64,
    cash_expenses: i64,
    transfer_revenue: i64,
    closed_at: DateTime<Utc>,
}
fn out_of_range() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        format!(
            "counted cash and opening float must be at most {} VND",
            money::MAX_AMOUNT
        ),
    )
}
pub(super) async fn put(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw): Path<String>,
    ValidJson(input): ValidJson<Input>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::DayClose)?;
    let day = date(&raw)?;
    // A day that has not happened yet has nothing to count, and a close for a day before the
    // app existed only hides later sales as "late". Compare with the store's business date.
    if day > state.clock.today() {
        return Err(ApiError::validation_failed(
            "cannot close a business day in the future",
        ));
    }
    if day < crate::time::EARLIEST_BUSINESS_DATE {
        return Err(ApiError::validation_failed(
            "business date is too far in the past to close",
        ));
    }
    if input.counted_cash < 0
        || input.opening_float < 0
        || input.note.as_ref().is_some_and(|n| n.chars().count() > 500)
    {
        return Err(ApiError::validation_failed(
            "cash must be nonnegative and note at most 500 characters",
        ));
    }
    if input.counted_cash > money::MAX_AMOUNT || input.opening_float > money::MAX_AMOUNT {
        return Err(out_of_range());
    }
    let mut tx = pool(&state)?.begin().await?;
    // Serialize concurrent re-closes before taking the aggregate snapshot.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("day-close:{}:{day}", actor.store_id))
        .execute(&mut *tx)
        .await?;
    // Sales and refunds count only the part paid now (`total - credit_amount`); what stayed on a
    // customer's tab is `credit_sales`, and collected debts come back as repayments by method.
    let c: Cash = sqlx::query_as(r#"
        WITH s AS (
            SELECT COALESCE(sum(total-credit_amount) FILTER (WHERE payment_method='cash'),0)::bigint cash_completed,
                COALESCE(sum(total-credit_amount) FILTER (WHERE payment_method='transfer'),0)::bigint transfer_revenue,
                COALESCE(sum(credit_amount),0)::bigint credit_sales
            FROM sales WHERE store_id=$1 AND business_date=$2 AND status='completed'
        ), v AS (
            SELECT COALESCE(sum(total-credit_amount),0)::bigint cash_refunds FROM sales
            WHERE store_id=$1 AND business_date=$2 AND status='voided' AND payment_method='cash'
        ), r AS (
            SELECT COALESCE(sum(-amount) FILTER (WHERE method='cash'),0)::bigint cash_repayments,
                COALESCE(sum(-amount) FILTER (WHERE method='transfer'),0)::bigint transfer_repayments
            FROM debt_entries WHERE store_id=$1 AND business_date=$2 AND kind='repayment'
        ), e AS (
            SELECT COALESCE(sum(amount),0)::bigint cash_expenses FROM expenses
            WHERE store_id=$1 AND business_date=$2 AND deleted_at IS NULL AND paid_with='cash_box'
        )
        SELECT s.cash_completed+v.cash_refunds cash_sales,v.cash_refunds,r.cash_repayments,
            r.transfer_repayments,s.credit_sales,e.cash_expenses,s.transfer_revenue,
            statement_timestamp() closed_at
        FROM s CROSS JOIN v CROSS JOIN r CROSS JOIN e
    "#).bind(actor.store_id).bind(day).fetch_one(&mut *tx).await?;
    let expected = money::expected_cash(
        input.opening_float,
        c.cash_sales,
        c.cash_refunds,
        c.cash_repayments,
        c.cash_expenses,
    )
    .ok_or_else(out_of_range)?;
    let row: Close = sqlx::query_as(r#"
        INSERT INTO day_closes (store_id,business_date,opening_float,cash_sales,cash_refunds,cash_expenses,
            expected_cash,counted_cash,transfer_revenue,note,closed_by,closed_at,
            cash_repayments,transfer_repayments,credit_sales)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (store_id,business_date) DO UPDATE SET opening_float=EXCLUDED.opening_float,
            cash_sales=EXCLUDED.cash_sales,cash_refunds=EXCLUDED.cash_refunds,cash_expenses=EXCLUDED.cash_expenses,
            cash_repayments=EXCLUDED.cash_repayments,transfer_repayments=EXCLUDED.transfer_repayments,
            credit_sales=EXCLUDED.credit_sales,
            expected_cash=EXCLUDED.expected_cash,counted_cash=EXCLUDED.counted_cash,
            transfer_revenue=EXCLUDED.transfer_revenue,note=EXCLUDED.note,closed_by=EXCLUDED.closed_by,
            closed_at=EXCLUDED.closed_at
        RETURNING *,0::bigint late_sales_count
    "#).bind(actor.store_id).bind(day).bind(input.opening_float).bind(c.cash_sales).bind(c.cash_refunds)
        .bind(c.cash_expenses).bind(expected).bind(input.counted_cash).bind(c.transfer_revenue)
        .bind(input.note).bind(actor.member_id).bind(c.closed_at)
        .bind(c.cash_repayments).bind(c.transfer_repayments).bind(c.credit_sales)
        .fetch_one(&mut *tx).await?;
    emit(&mut tx, Event {
        store_id:actor.store_id,actor:Some(actor.event_actor()),typ:"day.closed",version:1,
        data:json!({"business_date":day,"expected_cash":expected,"counted_cash":row.counted_cash,"difference":row.difference}),
        change:None,
    }).await?;
    tx.commit().await?;
    Ok(Json(json!(row)))
}
