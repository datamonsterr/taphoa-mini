//! Append-only sales, with transactional events and client-id replay protection.
mod review;

use crate::{
    ApiError, ApiResult, AppState,
    auth::data::pool,
    auth::{Action, Actor},
    error::ValidJson,
    events::{Event, emit},
    idempotency::{Idempotent, check, request_hash},
    money,
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
    time::business_date,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    routing::{get, post},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::HashSet;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/sales", get(list).post(create))
        .route("/v1/sales/{id}", get(get_sale))
        .route("/v1/sales/{id}/void", post(void))
        .merge(review::router())
}

#[derive(Debug, Deserialize)]
struct SaleInput {
    id: Uuid,
    sold_at: DateTime<Utc>,
    payment_method: String,
    cash_received: Option<i64>,
    total: i64,
    vietqr_memo: Option<String>,
    #[serde(default)]
    scan_ids: Vec<Uuid>,
    lines: Vec<LineInput>,
}
#[derive(Debug, Deserialize)]
struct LineInput {
    id: Uuid,
    product_id: Option<Uuid>,
    unit_id: Option<Uuid>,
    source: String,
    quantity: i32,
    unit_price: i64,
    manual_label: Option<String>,
    detection_id: Option<Uuid>,
    suggested_product_id: Option<Uuid>,
}
impl SaleInput {
    fn validate(&self) -> ApiResult<()> {
        if self.id.get_version_num() != 7
            || !(1..=200).contains(&self.lines.len())
            || !matches!(self.payment_method.as_str(), "cash" | "transfer")
            || self.total < 0
            || self
                .vietqr_memo
                .as_ref()
                .is_some_and(|s| s.chars().count() > 25)
            || (self.payment_method != "cash" && self.cash_received.is_some())
            || self
                .cash_received
                .is_some_and(|n| money::change_given(self.total, n).is_none())
        {
            return Err(ApiError::validation_failed("invalid sale"));
        }
        let mut ids = HashSet::new();
        for line in &self.lines {
            if !ids.insert(line.id)
                || !(1..=999).contains(&line.quantity)
                || line.unit_price < 0
                || !matches!(
                    line.source.as_str(),
                    "camera" | "multi_photo" | "barcode" | "grid" | "manual"
                )
                || (line.product_id.is_none()
                    && (line.source != "manual" || line.unit_id.is_some()))
                || line
                    .manual_label
                    .as_ref()
                    .is_some_and(|s| s.chars().count() > 80)
            {
                return Err(ApiError::validation_failed("invalid sale line"));
            }
        }
        let total = money::sum_lines(
            &self
                .lines
                .iter()
                .map(|l| (l.quantity, l.unit_price))
                .collect::<Vec<_>>(),
        )
        .ok_or_else(|| ApiError::validation_failed("sale total overflow"))?;
        if total != self.total {
            return Err(ApiError::bad_request(
                "total_mismatch",
                "total differs from the sum of lines",
            ));
        }
        Ok(())
    }
}
fn parse_id(id: &str) -> ApiResult<Uuid> {
    id.parse()
        .map_err(|_| ApiError::validation_failed("invalid id"))
}
fn query<T>(input: Result<Query<T>, QueryRejection>) -> ApiResult<T> {
    input
        .map(|Query(v)| v)
        .map_err(|e| ApiError::validation_failed(e.body_text()))
}
fn write_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        ApiError::conflict("id_conflict", "sale, line or detection already used")
    } else {
        error.into()
    }
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
            actor: Some((actor.member_id, actor.session_id)),
            typ,
            version: 1,
            data,
            // The sync feed contains catalog and membership entities only.
            change: None,
        },
    )
    .await?;
    Ok(())
}
async fn product_exists(conn: &mut PgConnection, store: Uuid, id: Uuid) -> ApiResult<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE store_id=$1 AND id=$2)")
            .bind(store)
            .bind(id)
            .fetch_one(conn)
            .await?;
    if exists {
        Ok(())
    } else {
        Err(ApiError::not_found())
    }
}
async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<Idempotent<Value>> {
    actor.require(Action::Sell)?;
    let id = parse_id(
        raw["id"]
            .as_str()
            .ok_or_else(|| ApiError::validation_failed("sale id required"))?,
    )?;
    let hash = request_hash(&raw);
    let mut tx = pool(&state)?.begin().await?;
    // Replay before catalog validation: later catalog changes cannot invalidate an accepted request.
    if let Some((store, stored)) =
        sqlx::query_as::<_, (Uuid, Vec<u8>)>("SELECT store_id,request_hash FROM sales WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
    {
        if store != actor.store_id {
            return Err(ApiError::not_found());
        }
        check(&stored, &hash)?;
        return Ok(Idempotent::Replay(sale(&mut tx, actor.store_id, id).await?));
    }
    let input: SaleInput =
        serde_json::from_value(raw).map_err(|e| ApiError::validation_failed(e.to_string()))?;
    input.validate()?;
    let date = business_date(input.sold_at);
    let code = money::sale_code(input.id);
    let won = sqlx::query("INSERT INTO sales(id,store_id,code,member_id,session_id,sold_at,business_date,payment_method,cash_received,total,vietqr_memo,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING")
        .bind(input.id).bind(actor.store_id).bind(&code).bind(actor.member_id).bind(actor.session_id).bind(input.sold_at).bind(date).bind(&input.payment_method).bind(input.cash_received).bind(input.total).bind(&input.vietqr_memo).bind(hash.as_slice())
        .execute(&mut *tx).await.map_err(write_error)?.rows_affected() == 1;
    if !won {
        let (store, stored): (Uuid, Vec<u8>) =
            sqlx::query_as("SELECT store_id,request_hash FROM sales WHERE id=$1")
                .bind(input.id)
                .fetch_one(&mut *tx)
                .await?;
        if store != actor.store_id {
            return Err(ApiError::not_found());
        }
        check(&stored, &hash)?;
        return Ok(Idempotent::Replay(
            sale(&mut tx, actor.store_id, input.id).await?,
        ));
    }
    let products: Vec<Uuid> = input
        .lines
        .iter()
        .filter_map(|line| line.product_id)
        .collect();
    crate::stock::lock_products(&mut tx, actor.store_id, &products).await?;
    for (position, line) in input.lines.iter().enumerate() {
        let mut quantity_in_base = 1;
        let mut mismatch = false;
        if let Some(product) = line.product_id {
            let current: i64 =
                sqlx::query_scalar("SELECT price FROM products WHERE store_id=$1 AND id=$2")
                    .bind(actor.store_id)
                    .bind(product)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(ApiError::not_found)?;
            if let Some(unit) = line.unit_id {
                quantity_in_base = sqlx::query_scalar("SELECT quantity_in_base FROM product_units WHERE store_id=$1 AND product_id=$2 AND id=$3")
                    .bind(actor.store_id).bind(product).bind(unit).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
            }
            let historical: Option<i64> = sqlx::query_scalar("SELECT new_value FROM price_history WHERE store_id=$1 AND product_id=$2 AND unit_id IS NOT DISTINCT FROM $3 AND field='price' AND changed_at <= $4 ORDER BY changed_at DESC,id DESC LIMIT 1")
                .bind(actor.store_id).bind(product).bind(line.unit_id).bind(input.sold_at).fetch_optional(&mut *tx).await?;
            mismatch = line.unit_price != historical.unwrap_or(current);
        }
        // Recommendation IDs are historical snapshots without a catalog foreign key.
        // Offline confirmations can outlive the suggested catalog entry.
        if let Some(product) = line.suggested_product_id {
            let foreign: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM products WHERE id=$1 AND store_id<>$2)",
            )
            .bind(product)
            .bind(actor.store_id)
            .fetch_one(&mut *tx)
            .await?;
            if foreign {
                return Err(ApiError::not_found());
            }
        }
        if let Some(detection) = line.detection_id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM detections WHERE store_id=$1 AND id=$2)",
            )
            .bind(actor.store_id)
            .bind(detection)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(ApiError::not_found());
            }
        }
        let reason = if line.product_id.is_none() {
            Some("manual_price")
        } else if mismatch {
            Some("price_mismatch")
        } else {
            None
        };
        sqlx::query("INSERT INTO sale_lines(id,store_id,sale_id,position,product_id,unit_id,source,quantity,unit_price,quantity_in_base,manual_label,detection_id,suggested_product_id,price_mismatch,review_status,review_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)")
            .bind(line.id).bind(actor.store_id).bind(input.id).bind(position as i16).bind(line.product_id).bind(line.unit_id).bind(&line.source).bind(line.quantity).bind(line.unit_price).bind(quantity_in_base).bind(&line.manual_label).bind(line.detection_id).bind(line.suggested_product_id).bind(mismatch).bind(reason.map(|_| "open")).bind(reason)
            .execute(&mut *tx).await.map_err(write_error)?;
        if let Some(product) = line.product_id {
            let quantity = line
                .quantity
                .checked_mul(quantity_in_base)
                .ok_or_else(|| ApiError::validation_failed("stock quantity overflow"))?;
            crate::stock::apply(
                &mut tx,
                actor.store_id,
                product,
                crate::stock::Change::Delta(-quantity),
                "sale",
                Some(input.id),
                Some(actor.member_id),
                None,
            )
            .await?;
        }
        if let Some(reason) = reason {
            event(&mut tx, &actor, "review.line_flagged", json!({"line_id":line.id,"sale_id":input.id,"reason":reason,"unit_price":line.unit_price})).await?;
        }
    }
    for scan in &input.scan_ids {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scans WHERE store_id=$1 AND id=$2)")
                .bind(actor.store_id)
                .bind(scan)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(ApiError::not_found());
        }
        sqlx::query("INSERT INTO sale_scans(sale_id,scan_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
            .bind(input.id)
            .bind(scan)
            .execute(&mut *tx)
            .await?;
    }
    event(&mut tx, &actor, "sale.created", json!({"sale_id":input.id,"code":code,"total":input.total,"payment_method":input.payment_method,"member_id":actor.member_id,"business_date":date,"line_count":input.lines.len()})).await?;
    let result = sale(&mut tx, actor.store_id, input.id).await?;
    tx.commit().await?;
    Ok(Idempotent::Created(result))
}

async fn sale(conn: &mut PgConnection, store: Uuid, id: Uuid) -> ApiResult<Value> {
    let mut value: Value = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'code',code,'sold_at',sold_at,'received_at',received_at,'business_date',business_date,'member_id',member_id,'payment_method',payment_method,'cash_received',cash_received,'total',total,'credit_amount',credit_amount,'customer_id',customer_id,'vietqr_memo',vietqr_memo,'status',status,'void',CASE WHEN status='voided' THEN jsonb_build_object('reason',void_reason,'voided_by',voided_by,'voided_at',voided_at) ELSE NULL END) FROM sales WHERE store_id=$1 AND id=$2")
        .bind(store).bind(id).fetch_optional(&mut *conn).await?.ok_or_else(ApiError::not_found)?;
    let total = value["total"].as_i64().ok_or_else(ApiError::internal)?;
    value["change_given"] = json!(
        value["cash_received"]
            .as_i64()
            .and_then(|n| money::change_given(total, n))
    );
    let lines: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',l.id,'product_id',l.product_id,'unit_id',l.unit_id,'source',l.source,'quantity',l.quantity,'unit_price',l.unit_price,'manual_label',l.manual_label,'detection_id',l.detection_id,'suggested_product_id',l.suggested_product_id,'line_total',l.line_total,'price_mismatch',l.price_mismatch,'product_name',p.name) FROM sale_lines l LEFT JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id WHERE l.store_id=$1 AND l.sale_id=$2 ORDER BY l.position")
        .bind(store).bind(id).fetch_all(conn).await?;
    // Optional input strings are omitted rather than serialized as null (SaleLineInput schema).
    value["lines"] = json!(
        lines
            .into_iter()
            .map(|mut l| {
                if l["manual_label"].is_null() {
                    l.as_object_mut()
                        .expect("line object")
                        .remove("manual_label");
                }
                l
            })
            .collect::<Vec<_>>()
    );
    Ok(value)
}
async fn get_sale(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::Sell)?;
    Ok(Json(
        sale(
            &mut *pool(&state)?.acquire().await?,
            actor.store_id,
            parse_id(&id)?,
        )
        .await?,
    ))
}
#[derive(Default, Deserialize)]
struct Filters {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    member_id: Option<Uuid>,
    payment_method: Option<String>,
    status: Option<String>,
}
async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
    filters: Result<Query<Filters>, QueryRejection>,
) -> ApiResult<Json<Page<Value>>> {
    actor.require(Action::Sell)?;
    let f = query(filters)?;
    if f.payment_method
        .as_deref()
        .is_some_and(|s| !matches!(s, "cash" | "transfer" | "credit"))
        || f.status
            .as_deref()
            .is_some_and(|s| !matches!(s, "completed" | "voided"))
        || matches!((f.from,f.to),(Some(a),Some(b)) if a>b)
    {
        return Err(ApiError::validation_failed("invalid sales filters"));
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut conn = pool(&state)?.acquire().await?;
    let mut rows: Vec<(Uuid, DateTime<Utc>)> = sqlx::query_as("SELECT id,sold_at FROM sales WHERE store_id=$1 AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3) AND ($4::uuid IS NULL OR member_id=$4) AND ($5::text IS NULL OR payment_method=$5) AND ($6::text IS NULL OR status=$6) AND ($7::timestamptz IS NULL OR (sold_at,id)<($7,$8)) ORDER BY sold_at DESC,id DESC LIMIT $9")
        .bind(actor.store_id).bind(f.from).bind(f.to).bind(f.member_id).bind(f.payment_method).bind(f.status).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(i64::from(page.limit)+1).fetch_all(&mut *conn).await?;
    let next_cursor = if rows.len() > page.limit as usize {
        rows.pop();
        rows.last()
            .map(|(id, at)| encode_cursor(&(*at, *id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    let mut items = Vec::with_capacity(rows.len());
    for (id, _) in rows {
        items.push(sale(&mut conn, actor.store_id, id).await?);
    }
    Ok(Json(Page { items, next_cursor }))
}
#[derive(Deserialize)]
struct VoidInput {
    reason: String,
    voided_at: Option<DateTime<Utc>>,
}
async fn void(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ValidJson(input): ValidJson<VoidInput>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::VoidOwnSaleSameDay)?;
    if input.reason.trim().is_empty() || input.reason.chars().count() > 200 {
        return Err(ApiError::validation_failed(
            "reason must contain 1 to 200 characters",
        ));
    }
    let id = parse_id(&id)?;
    let mut tx = pool(&state)?.begin().await?;
    let (member,date,status,total): (Uuid,NaiveDate,String,i64) = sqlx::query_as("SELECT member_id,business_date,status,total FROM sales WHERE store_id=$1 AND id=$2 FOR UPDATE").bind(actor.store_id).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    if !money::can_void(&actor, member, date, business_date(Utc::now())) {
        return Err(ApiError::forbidden());
    }
    if status != "voided" {
        let lines: Vec<(Uuid, i32, i32)> = sqlx::query_as("SELECT product_id,quantity,quantity_in_base FROM sale_lines WHERE store_id=$1 AND sale_id=$2 AND product_id IS NOT NULL ORDER BY position")
            .bind(actor.store_id).bind(id).fetch_all(&mut *tx).await?;
        let products: Vec<Uuid> = lines.iter().map(|(product, _, _)| *product).collect();
        crate::stock::lock_products(&mut tx, actor.store_id, &products).await?;
        for (product, quantity, size) in lines {
            let quantity = quantity
                .checked_mul(size)
                .ok_or_else(|| ApiError::validation_failed("stock quantity overflow"))?;
            crate::stock::apply(
                &mut tx,
                actor.store_id,
                product,
                crate::stock::Change::Delta(quantity),
                "sale_void",
                Some(id),
                Some(actor.member_id),
                None,
            )
            .await?;
        }
        sqlx::query("UPDATE sales SET status='voided',void_reason=$3,voided_by=$4,voided_at=$5 WHERE store_id=$1 AND id=$2").bind(actor.store_id).bind(id).bind(&input.reason).bind(actor.member_id).bind(input.voided_at.unwrap_or_else(Utc::now)).execute(&mut *tx).await?;
        event(
            &mut tx,
            &actor,
            "sale.voided",
            json!({"sale_id":id,"reason":input.reason,"voided_by":actor.member_id,"total":total}),
        )
        .await?;
    }
    let result = sale(&mut tx, actor.store_id, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"id":Uuid::now_v7(),"sold_at":"2026-10-23T09:00:00Z","payment_method":"cash","total":10,"lines":[{"id":Uuid::now_v7(),"product_id":Uuid::now_v7(),"source":"grid","quantity":2,"unit_price":5}]})
    }
    fn validate(value: Value) -> ApiResult<()> {
        serde_json::from_value::<SaleInput>(value)
            .unwrap()
            .validate()
    }
    #[test]
    fn validates_sale_bounds_and_overflow() {
        assert!(validate(input()).is_ok());
        for (field, value) in [
            ("id", json!(Uuid::new_v4())),
            ("lines", json!([])),
            ("payment_method", json!("card")),
            ("cash_received", json!(9)),
            ("vietqr_memo", json!("a".repeat(26))),
        ] {
            let mut v = input();
            v[field] = value;
            assert_eq!(validate(v).unwrap_err().code, "validation_failed");
        }
        let mut v = input();
        v["total"] = json!(11);
        assert_eq!(validate(v).unwrap_err().code, "total_mismatch");
        let mut v = input();
        v["lines"][0]["unit_price"] = json!(i64::MAX);
        assert_eq!(validate(v).unwrap_err().code, "validation_failed");
        let mut v = input();
        v["lines"][0]["manual_label"] = json!("ạ".repeat(80));
        assert!(validate(v).is_ok());
    }
    #[test]
    fn validates_line_relationships_and_duplicates() {
        for (field, value) in [
            ("quantity", json!(0)),
            ("quantity", json!(1000)),
            ("unit_price", json!(-1)),
            ("source", json!("unknown")),
            ("manual_label", json!("ạ".repeat(81))),
        ] {
            let mut v = input();
            v["lines"][0][field] = value;
            assert_eq!(validate(v).unwrap_err().code, "validation_failed");
        }
        let mut v = input();
        v["lines"][0]["product_id"] = Value::Null;
        assert!(validate(v.clone()).is_err());
        v["lines"][0]["source"] = json!("manual");
        assert!(validate(v.clone()).is_ok());
        v["lines"][0]["unit_id"] = json!(Uuid::now_v7());
        assert!(validate(v).is_err());
        let mut v = input();
        let duplicate = v["lines"][0].clone();
        v["lines"].as_array_mut().unwrap().push(duplicate);
        assert!(validate(v).is_err());
        let mut v = input();
        v["payment_method"] = json!("transfer");
        v["cash_received"] = json!(10);
        assert!(validate(v).is_err());
    }
}
