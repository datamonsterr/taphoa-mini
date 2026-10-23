//! Store-scoped money and recognition reports. Each report uses one aggregate query.
mod day_close;
mod export;

use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    money,
    time::business_date,
};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    routing::get,
};
use chrono::{Datelike, Duration, Months, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/reports/today", get(today))
        .route("/v1/reports/summary", get(summary))
        .route("/v1/reports/top-products", get(top_products))
        .route("/v1/reports/recognition", get(recognition))
        .route("/v1/exports/transactions", get(export::transactions))
        .route("/v1/day-closes", get(day_close::list))
        .route(
            "/v1/day-closes/{businessDate}",
            get(day_close::get).put(day_close::put),
        )
}
fn query<T>(input: Result<Query<T>, QueryRejection>) -> ApiResult<T> {
    input
        .map(|Query(v)| v)
        .map_err(|e| ApiError::validation_failed(e.body_text()))
}
#[derive(Deserialize)]
struct Range {
    from: NaiveDate,
    to: NaiveDate,
}
impl Range {
    fn validate(&self) -> ApiResult<()> {
        if self.from > self.to {
            Err(ApiError::validation_failed("from must not follow to"))
        } else {
            Ok(())
        }
    }
}
#[derive(Deserialize)]
struct TodayParams {
    date: Option<NaiveDate>,
}
// Separate completed/voided aggregates allow each partial store/date index to be used.
pub(super) const TODAY_SQL: &str = r#"
WITH close AS (SELECT * FROM day_closes WHERE store_id=$1 AND business_date=$2),
s AS (
    SELECT COALESCE(sum(total),0)::bigint revenue, count(*) sales_count,
        COALESCE(sum(total) FILTER (WHERE payment_method='cash'),0)::bigint cash_revenue,
        COALESCE(sum(total) FILTER (WHERE payment_method='transfer'),0)::bigint transfer_revenue,
        count(*) FILTER (WHERE received_at > (SELECT closed_at FROM close)) late_sales_count
    FROM sales WHERE store_id=$1 AND business_date=$2 AND status='completed'
), v AS (
    SELECT count(*) voided_count FROM sales
    WHERE store_id=$1 AND business_date=$2 AND status='voided'
), e AS (
    SELECT COALESCE(sum(amount),0)::bigint expenses,
        COALESCE(sum(amount) FILTER (WHERE paid_with='cash_box'),0)::bigint cash_expenses
    FROM expenses WHERE store_id=$1 AND business_date=$2 AND deleted_at IS NULL
)
SELECT s.*,v.*,e.*,COALESCE((SELECT opening_float FROM close),0) opening_float,
    (SELECT count(*) FROM sale_lines WHERE store_id=$1 AND review_status='open') manual_lines_open,
    (SELECT (to_jsonb(c)-'store_id') || jsonb_build_object('late_sales_count',s.late_sales_count)
     FROM close c) day_close
FROM s CROSS JOIN v CROSS JOIN e
"#;
#[derive(sqlx::FromRow)]
struct DailyRow {
    revenue: i64,
    sales_count: i64,
    cash_revenue: i64,
    transfer_revenue: i64,
    voided_count: i64,
    expenses: i64,
    cash_expenses: i64,
    opening_float: i64,
    manual_lines_open: i64,
    day_close: Option<Value>,
}
async fn today(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<TodayParams>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let date = query(params)?
        .date
        .unwrap_or_else(|| business_date(Utc::now()));
    let r: DailyRow = sqlx::query_as(TODAY_SQL)
        .bind(actor.store_id)
        .bind(date)
        .fetch_one(pool(&state)?)
        .await?;
    Ok(Json(
        json!({"business_date":date,"revenue":r.revenue,"sales_count":r.sales_count,
        "voided_count":r.voided_count,"cash_revenue":r.cash_revenue,"transfer_revenue":r.transfer_revenue,
        "expenses":r.expenses,"net":r.revenue-r.expenses,
        "expected_cash":money::expected_cash(r.opening_float,r.cash_revenue,0,r.cash_expenses),
        "manual_lines_open":r.manual_lines_open,"day_close":r.day_close}),
    ))
}
#[derive(Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum Granularity {
    Day,
    Week,
    Month,
}
impl Granularity {
    fn sql(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }
    fn bounds(self, date: NaiveDate, range: &Range) -> (NaiveDate, NaiveDate) {
        let start = match self {
            Self::Day => date,
            Self::Week => date - Duration::days(i64::from(date.weekday().num_days_from_monday())),
            Self::Month => date.with_day(1).expect("first day exists"),
        };
        let end = match self {
            Self::Day => start,
            Self::Week => start + Duration::days(6),
            Self::Month => start + Months::new(1) - Duration::days(1),
        };
        (start.max(range.from), end.min(range.to))
    }
}
#[derive(Deserialize)]
struct SummaryParams {
    #[serde(flatten)]
    range: Range,
    granularity: Option<Granularity>,
}
pub(super) const SUMMARY_SQL: &str = r#"
SELECT date_trunc($4, business_date::timestamp)::date bucket,
    sum(revenue)::bigint revenue, sum(expenses)::bigint expenses, sum(sales_count)::bigint sales_count
FROM (
    SELECT business_date, sum(total)::bigint revenue, 0::bigint expenses, count(*) sales_count
    FROM sales WHERE store_id=$1 AND business_date BETWEEN $2 AND $3 AND status='completed'
    GROUP BY business_date
    UNION ALL
    SELECT business_date, 0::bigint, sum(amount)::bigint, 0::bigint
    FROM expenses WHERE store_id=$1 AND business_date BETWEEN $2 AND $3 AND deleted_at IS NULL
    GROUP BY business_date
) activity GROUP BY bucket ORDER BY bucket
"#;
#[derive(sqlx::FromRow)]
struct BucketRow {
    bucket: NaiveDate,
    revenue: i64,
    expenses: i64,
    sales_count: i64,
}
async fn summary(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<SummaryParams>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let p = query(params)?;
    p.range.validate()?;
    let granularity = p.granularity.unwrap_or(Granularity::Day);
    let rows: Vec<BucketRow> = sqlx::query_as(SUMMARY_SQL)
        .bind(actor.store_id)
        .bind(p.range.from)
        .bind(p.range.to)
        .bind(granularity.sql())
        .fetch_all(pool(&state)?)
        .await?;
    let buckets: Vec<_> = rows
        .into_iter()
        .map(|r| {
            let (start, end) = granularity.bounds(r.bucket, &p.range);
            json!({"start":start,"end":end,"revenue":r.revenue,"expenses":r.expenses,
            "net":r.revenue-r.expenses,"sales_count":r.sales_count})
        })
        .collect();
    Ok(Json(json!({"granularity":granularity,"buckets":buckets})))
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Sort {
    Revenue,
    Quantity,
}
#[derive(Deserialize)]
struct TopParams {
    #[serde(flatten)]
    range: Range,
    sort: Option<Sort>,
    limit: Option<i64>,
}
async fn top_products(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<TopParams>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let p = query(params)?;
    p.range.validate()?;
    let limit = p.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::validation_failed("limit must be 1..100"));
    }
    let quantity_sort = matches!(p.sort, Some(Sort::Quantity));
    let items: Vec<Value> = sqlx::query_scalar(r#"
        SELECT to_jsonb(r) FROM (
            SELECT p.id product_id,p.name,
                sum(l.quantity::bigint*l.quantity_in_base)::bigint quantity,
                sum(l.line_total)::bigint revenue,
                (sum(l.line_total)-sum(l.quantity::bigint*l.quantity_in_base)*p.cost_price)::bigint gross_margin
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 AND s.status='completed'
            GROUP BY p.id
            ORDER BY CASE WHEN $4 THEN sum(l.quantity::bigint*l.quantity_in_base) ELSE sum(l.line_total) END DESC,p.id
            LIMIT $5
        ) r
    "#).bind(actor.store_id).bind(p.range.from).bind(p.range.to).bind(quantity_sort).bind(limit)
        .fetch_all(pool(&state)?).await?;
    Ok(Json(json!({"items":items})))
}
async fn recognition(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<Range>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::RecognitionReport)?;
    let range = query(params)?;
    range.validate()?;
    let result: Value = sqlx::query_scalar(r#"
        WITH linked AS MATERIALIZED (
            SELECT l.product_id,l.suggested_product_id,d.match,d.candidates,d.scan_id
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            JOIN detections d ON d.id=l.detection_id AND d.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3
        ), counts AS (
            SELECT count(*) detections,
                count(*) FILTER (WHERE suggested_product_id=product_id) confirmed_top1,
                count(*) FILTER (WHERE suggested_product_id IS NOT NULL AND suggested_product_id<>product_id) corrected,
                count(*) FILTER (WHERE match='unknown') unknown,
                count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM jsonb_array_elements(candidates) WITH ORDINALITY c(candidate,rank)
                    WHERE rank<=3 AND candidate->>'product_id'=linked.product_id::text
                )) confirmed_top3
            FROM linked
        ), timing AS (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (s.timings->>'total')::double precision)::bigint median_scan_ms
            FROM scans s JOIN (SELECT DISTINCT scan_id FROM linked) l ON l.scan_id=s.id
            WHERE s.store_id=$1 AND s.timings->>'total' IS NOT NULL
        )
        SELECT jsonb_strip_nulls(to_jsonb(counts) || to_jsonb(timing) ||
            jsonb_build_object('top1_rate',COALESCE(confirmed_top1::double precision/NULLIF(detections,0),0)))
        FROM counts CROSS JOIN timing
    "#).bind(actor.store_id).bind(range.from).bind(range.to).fetch_one(pool(&state)?).await?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bucket_boundaries_and_clipping() {
        let date = |s: &str| s.parse::<NaiveDate>().unwrap();
        let range = Range {
            from: date("2025-12-31"),
            to: date("2026-03-04"),
        };
        for (g, day, start, end) in [
            (Granularity::Day, "2026-01-01", "2026-01-01", "2026-01-01"),
            (Granularity::Week, "2026-01-01", "2025-12-31", "2026-01-04"),
            (Granularity::Week, "2026-03-04", "2026-03-02", "2026-03-04"),
            (Granularity::Month, "2026-02-10", "2026-02-01", "2026-02-28"),
            (Granularity::Month, "2026-03-01", "2026-03-01", "2026-03-04"),
        ] {
            assert_eq!(g.bounds(date(day), &range), (date(start), date(end)));
        }
        let leap = Range {
            from: date("2024-02-01"),
            to: date("2024-03-01"),
        };
        assert_eq!(
            Granularity::Month.bounds(date("2024-02-20"), &leap),
            (date("2024-02-01"), date("2024-02-29"))
        );
    }
}
