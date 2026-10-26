//! Synchronous receipt ingestion and atomic confirmation into purchases and stock.
//! Confirmation replaces the full retained line set: omitted draft lines are deleted.
//! Existing line IDs preserve OCR metadata; new lines use the selected catalog name.
//! ImageRepository has no purpose-update port, so the scan image's purpose is retained.
use super::{CANDIDATE_PREFILTER_SQL, CatalogCandidate, OcrText, map_lines, parse_lines};
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    error::ValidJson,
    events::{Event, emit},
    expenses::{CreateExpense, PurchaseLine, create_in_transaction},
    idempotency::{check, request_hash},
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
    stock::{self, Change},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{collections::HashSet, time::Instant};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/receipts", get(list).post(create))
        .route("/v1/receipts/{id}", get(detail).delete(discard))
        .route("/v1/receipts/{id}/confirm", post(confirm))
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        message,
    )
}
fn receipt_id(id: &str) -> ApiResult<Uuid> {
    id.parse().map_err(|_| invalid("invalid receipt id"))
}
fn millis(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}
fn key(headers: &HeaderMap) -> ApiResult<[u8; 32]> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| invalid("Idempotency-Key required"))?;
    Ok(request_hash(&json!(key)))
}
async fn saved(
    conn: &mut PgConnection,
    actor: &Actor,
    operation: &str,
    key: &[u8; 32],
    hash: &[u8; 32],
    id: Option<Uuid>,
) -> ApiResult<Option<Uuid>> {
    // Advisory admission never acquires the store row before the product set.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "receipt:{}:{operation}:{}",
            actor.store_id,
            hex::encode(key)
        ))
        .execute(&mut *conn)
        .await?;
    let saved:Option<(Uuid,Vec<u8>)>=sqlx::query_as("SELECT receipt_id,request_hash FROM receipt_requests WHERE store_id=$1 AND operation=$2 AND key_hash=$3")
        .bind(actor.store_id).bind(operation).bind(key.as_slice()).fetch_optional(conn).await?;
    if let Some((stored_id, stored_hash)) = saved {
        check(&stored_hash, hash)?;
        if id.is_some_and(|id| id != stored_id) {
            return Err(ApiError::conflict(
                "id_conflict",
                "key already used for another receipt",
            ));
        }
        Ok(Some(stored_id))
    } else {
        Ok(None)
    }
}
async fn save(
    conn: &mut PgConnection,
    actor: &Actor,
    operation: &str,
    key: &[u8; 32],
    hash: &[u8; 32],
    id: Uuid,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO receipt_requests(store_id,operation,key_hash,request_hash,receipt_id) VALUES($1,$2,$3,$4,$5)")
        .bind(actor.store_id).bind(operation).bind(key.as_slice()).bind(hash.as_slice()).bind(id).execute(conn).await?;
    Ok(())
}
#[derive(sqlx::FromRow)]
struct ReceiptRow {
    id: Uuid,
    status: String,
    image_id: Uuid,
    object_key: String,
    total: i64,
    parser: String,
    model: Option<String>,
    timings: Value,
    expense_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    confirmed_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    line_count: i64,
    #[sqlx(default)]
    matched_count: i64,
}
async fn load(conn: &mut PgConnection, store: Uuid, id: Uuid) -> ApiResult<ReceiptRow> {
    sqlx::query_as("SELECT r.*,i.object_key FROM receipts r JOIN images i ON i.id=r.image_id AND i.store_id=r.store_id WHERE r.store_id=$1 AND r.id=$2")
        .bind(store).bind(id).fetch_optional(conn).await?.ok_or_else(ApiError::not_found)
}
async fn image_url(state: &AppState, key: &str) -> ApiResult<String> {
    Ok(crate::catalog::products::signed_url(state, key).await?.0)
}
async fn response(conn: &mut PgConnection, state: &AppState, row: ReceiptRow) -> ApiResult<Value> {
    let lines:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'position',position,'raw_text',raw_text,'product_name',product_name,'quantity',quantity,'cost',cost,'product_id',product_id,'match_confidence',match_confidence,'candidates',candidates) FROM receipt_lines WHERE receipt_id=$1 ORDER BY position")
        .bind(row.id).fetch_all(conn).await?;
    Ok(
        json!({"id":row.id,"status":row.status,"image_id":row.image_id,"image_url":image_url(state,&row.object_key).await?,"total":row.total,"parser":row.parser,"model":row.model,"lines":lines,"timings":row.timings,"expense_id":row.expense_id,"created_at":row.created_at,"confirmed_at":row.confirmed_at}),
    )
}
#[derive(Deserialize)]
struct Create {
    image_id: Uuid,
}
#[derive(sqlx::FromRow)]
struct Prefilter {
    line_index: i64,
    product_id: Uuid,
    name: String,
    price: i64,
    similarity: f32,
}
async fn create(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    actor.require(Action::EnrollProduct)?;
    let wall = Instant::now();
    let key = key(&headers)?;
    let hash = request_hash(&raw);
    let mut tx = pool(&state)?.begin().await?;
    if let Some(id) = saved(&mut tx, &actor, "create", &key, &hash, None).await? {
        let row = load(&mut tx, actor.store_id, id).await?;
        let value = response(&mut tx, &state, row).await?;
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(value)));
    }
    let input: Create = serde_json::from_value(raw).map_err(|_| invalid("invalid receipt"))?;
    let ocr = state.receipt_ocr.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ocr_unavailable",
            "receipt OCR not configured",
        )
    })?;
    let object_key: String =
        sqlx::query_scalar("SELECT object_key FROM images WHERE store_id=$1 AND id=$2")
            .bind(actor.store_id)
            .bind(input.image_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::not_found)?;
    let storage = state.storage.as_ref().ok_or_else(ApiError::unavailable)?;
    let bytes = storage.get(&object_key).await.map_err(|error| {
        tracing::error!(%error,"receipt image read failed");
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "storage_failure",
            "image read failed",
        )
    })?;
    let permit = state
        .inference_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| crate::busy())?;
    let started = Instant::now();
    let lines = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        ocr.read_lines(&bytes)
    })
    .await
    .map_err(|_| ApiError::internal())?
    .map_err(|error| {
        tracing::error!(%error,"receipt OCR failed");
        ApiError::internal()
    })?;
    let ocr_ms = millis(started);
    if lines.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "no_text",
            "no text found",
        ));
    }
    let started = Instant::now();
    let text: Vec<_> = lines
        .into_iter()
        .map(|l| OcrText {
            text: l.text,
            confidence: l.confidence,
            bbox: l.bbox,
        })
        .collect();
    let parsed = parse_lines(&text);
    let parse_ms = millis(started);
    let names: Vec<_> = parsed.iter().map(|l| l.product_name.clone()).collect();
    let candidates: Vec<Prefilter> = sqlx::query_as(CANDIDATE_PREFILTER_SQL)
        .bind(actor.store_id)
        .bind(names)
        .fetch_all(&mut *tx)
        .await?;
    let mut catalog = vec![vec![]; parsed.len()];
    for c in candidates {
        catalog[c.line_index as usize].push(CatalogCandidate {
            product_id: c.product_id,
            name: c.name,
            price: c.price,
            similarity: c.similarity,
        });
    }
    let mapped = map_lines(state.decisions.as_deref(), &parsed, &catalog).await;
    let total = mapped
        .lines
        .iter()
        .try_fold(0i64, |sum, l| sum.checked_add(l.candidate.cost))
        .ok_or_else(|| invalid("receipt total overflow"))?;
    let timings =
        json!({"ocr":ocr_ms,"parse":parse_ms,"decisions":mapped.decisions_ms,"total":millis(wall)});
    let id = Uuid::now_v7();
    let ocr_text = text
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    sqlx::query("INSERT INTO receipts(id,store_id,member_id,image_id,ocr_text,parser,model,timings,total,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(id).bind(actor.store_id).bind(actor.member_id).bind(input.image_id).bind(ocr_text).bind(mapped.parser).bind(mapped.model).bind(&timings).bind(total).bind(hash.as_slice()).execute(&mut *tx).await?;
    let line_count = mapped.lines.len();
    let matched_lines = mapped
        .lines
        .iter()
        .filter(|l| l.product_id.is_some())
        .count();
    for l in mapped.lines {
        sqlx::query("INSERT INTO receipt_lines(receipt_id,store_id,position,raw_text,product_name,quantity,cost,product_id,match_confidence,candidates) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(id).bind(actor.store_id).bind(l.candidate.position as i32).bind(l.candidate.raw_text).bind(l.candidate.product_name).bind(l.candidate.quantity).bind(l.candidate.cost).bind(l.product_id).bind(l.match_confidence).bind(json!(l.candidates)).execute(&mut *tx).await?;
    }
    emit(&mut tx,Event{store_id:actor.store_id,actor:Some((actor.member_id,actor.session_id)),typ:"receipt.scanned",version:1,data:json!({"receipt_id":id,"line_count":line_count,"matched_lines":matched_lines,"latency_ms":timings["total"]}),change:None}).await?;
    save(&mut tx, &actor, "create", &key, &hash, id).await?;
    let row = load(&mut tx, actor.store_id, id).await?;
    let value = response(&mut tx, &state, row).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(value)))
}
#[derive(Deserialize)]
struct Filters {
    status: Option<String>,
}
async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
    filters: Result<Query<Filters>, QueryRejection>,
) -> ApiResult<Json<Page<Value>>> {
    actor.require(Action::EnrollProduct)?;
    let Query(filters) = filters.map_err(|_| invalid("invalid filters"))?;
    if filters
        .status
        .as_ref()
        .is_some_and(|s| !["draft", "confirmed", "discarded"].contains(&s.as_str()))
    {
        return Err(invalid("invalid status"));
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut conn = pool(&state)?.acquire().await?;
    let mut rows:Vec<ReceiptRow>=sqlx::query_as("SELECT r.*,i.object_key,(SELECT count(*) FROM receipt_lines l WHERE l.receipt_id=r.id) AS line_count,(SELECT count(*) FROM receipt_lines l WHERE l.receipt_id=r.id AND l.product_id IS NOT NULL) AS matched_count FROM receipts r JOIN images i ON i.id=r.image_id AND i.store_id=r.store_id WHERE r.store_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3,$4)) ORDER BY r.created_at DESC,r.id DESC LIMIT $5")
        .bind(actor.store_id).bind(filters.status).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(i64::from(page.limit)+1).fetch_all(&mut *conn).await?;
    let more = rows.len() > page.limit as usize;
    rows.truncate(page.limit as usize);
    let next_cursor = if more {
        rows.last()
            .map(|r| encode_cursor(&(r.created_at, r.id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    let mut items = Vec::new();
    for r in rows {
        items.push(json!({"id":r.id,"status":r.status,"total":r.total,"line_count":r.line_count,"matched_count":r.matched_count,"image_url":image_url(&state,&r.object_key).await?,"created_at":r.created_at,"confirmed_at":r.confirmed_at,"expense_id":r.expense_id}));
    }
    Ok(Json(Page { items, next_cursor }))
}
async fn detail(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::EnrollProduct)?;
    let mut conn = pool(&state)?.acquire().await?;
    let row = load(&mut conn, actor.store_id, receipt_id(&id)?).await?;
    Ok(Json(response(&mut conn, &state, row).await?))
}
async fn locked_status(conn: &mut PgConnection, actor: &Actor, id: Uuid) -> ApiResult<String> {
    sqlx::query_scalar("SELECT status FROM receipts WHERE store_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.store_id)
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::not_found)
}
async fn discard(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    actor.require(Action::EnrollProduct)?;
    let id = receipt_id(&id)?;
    let mut tx = pool(&state)?.begin().await?;
    if locked_status(&mut tx, &actor, id).await? == "confirmed" {
        return Err(ApiError::conflict(
            "already_confirmed",
            "receipt already confirmed",
        ));
    }
    sqlx::query("UPDATE receipts SET status='discarded',updated_at=clock_timestamp() WHERE id=$1 AND store_id=$2").bind(id).bind(actor.store_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct ConfirmLine {
    line_id: Option<Uuid>,
    product_id: Uuid,
    quantity: i32,
    cost: i64,
}
#[derive(Deserialize)]
struct Confirm {
    lines: Vec<ConfirmLine>,
    paid_with: String,
    spent_at: Option<DateTime<Utc>>,
}
async fn confirm(
    State(state): State<AppState>,
    crate::events::Via(via): crate::events::Via,
    actor: Actor,
    Path(id): Path<String>,
    headers: HeaderMap,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::EnrollProduct)?;
    let id = receipt_id(&id)?;
    let key = key(&headers)?;
    let hash = request_hash(&raw);
    let mut tx = pool(&state)?.begin().await?;
    if saved(&mut tx, &actor, "confirm", &key, &hash, Some(id))
        .await?
        .is_some()
    {
        let row = load(&mut tx, actor.store_id, id).await?;
        let value = response(&mut tx, &state, row).await?;
        tx.commit().await?;
        return Ok(Json(value));
    }
    let status = locked_status(&mut tx, &actor, id).await?;
    if status == "confirmed" {
        return Err(ApiError::conflict(
            "already_confirmed",
            "receipt already confirmed",
        ));
    }
    if status != "draft" {
        return Err(ApiError::conflict(
            "receipt_discarded",
            "receipt has been discarded",
        ));
    }
    let input: Confirm =
        serde_json::from_value(raw).map_err(|_| invalid("invalid confirmation"))?;
    if !(1..=100).contains(&input.lines.len())
        || !["cash_box", "other"].contains(&input.paid_with.as_str())
        || input.lines.iter().any(|l| l.quantity <= 0 || l.cost < 0)
    {
        return Err(invalid("invalid confirmation lines or paid_with"));
    }
    let total = input
        .lines
        .iter()
        .try_fold(0i64, |sum, l| sum.checked_add(l.cost))
        .ok_or_else(|| invalid("total overflow"))?;
    let products: Vec<_> = input.lines.iter().map(|l| l.product_id).collect();
    stock::lock_products(&mut tx, actor.store_id, &products)
        .await
        .map_err(|e| {
            if e.status == StatusCode::NOT_FOUND {
                invalid("unknown product")
            } else {
                e
            }
        })?;
    let valid: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM products WHERE store_id=$1 AND id=ANY($2) AND NOT archived",
    )
    .bind(actor.store_id)
    .bind(&products)
    .fetch_one(&mut *tx)
    .await?;
    if valid as usize != products.iter().collect::<HashSet<_>>().len() {
        return Err(invalid("unknown or archived product"));
    }
    let existing:Vec<(Uuid,String,String,Option<f32>,Value)>=sqlx::query_as("SELECT id,raw_text,product_name,match_confidence,candidates FROM receipt_lines WHERE receipt_id=$1").bind(id).fetch_all(&mut *tx).await?;
    let mut retained = HashSet::new();
    for line in &input.lines {
        if let Some(line_id) = line.line_id
            && (!retained.insert(line_id) || !existing.iter().any(|l| l.0 == line_id))
        {
            return Err(invalid("unknown or duplicate receipt line"));
        }
    }
    let row = load(&mut tx, actor.store_id, id).await?;
    let expense = CreateExpense {
        id: Uuid::now_v7(),
        spent_at: input.spent_at.unwrap_or_else(Utc::now),
        amount: total,
        category: "nhap_hang".into(),
        paid_with: input.paid_with,
        image_id: Some(row.image_id),
        note: None,
        purchase_lines: input
            .lines
            .iter()
            .map(|l| PurchaseLine {
                product_id: l.product_id,
                unit_id: None,
                quantity: l.quantity,
                unit_cost: l.cost / i64::from(l.quantity)
                    + i64::from(l.cost % i64::from(l.quantity) != 0),
            })
            .collect(),
    };
    create_in_transaction(&mut tx, &actor, &expense, &hash, via).await?;
    // Delete and reinsert the full retained set to allow line reordering without
    // colliding with UNIQUE(receipt_id, position). Existing UUIDs and OCR survive.
    sqlx::query("DELETE FROM receipt_lines WHERE receipt_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for (position, line) in input.lines.iter().enumerate() {
        stock::apply(
            &mut tx,
            actor.store_id,
            line.product_id,
            Change::Delta(line.quantity),
            "receipt",
            Some(id),
            Some(actor.member_id),
            None,
            None,
        )
        .await?;
        let metadata = existing.iter().find(|l| Some(l.0) == line.line_id);
        let name: Option<String> =
            sqlx::query_scalar("SELECT name FROM products WHERE store_id=$1 AND id=$2")
                .bind(actor.store_id)
                .bind(line.product_id)
                .fetch_one(&mut *tx)
                .await?;
        let (line_id, raw, name, confidence, candidates) = match metadata {
            Some(l) => (l.0, l.1.clone(), l.2.clone(), l.3, l.4.clone()),
            None => (
                Uuid::now_v7(),
                String::new(),
                name.unwrap_or_default(),
                None,
                json!([]),
            ),
        };
        sqlx::query("INSERT INTO receipt_lines(id,receipt_id,store_id,position,raw_text,product_name,product_id,quantity,cost,match_confidence,candidates) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(line_id).bind(id).bind(actor.store_id).bind(position as i32).bind(raw).bind(name).bind(line.product_id).bind(line.quantity).bind(line.cost).bind(confidence).bind(candidates).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE receipts SET status='confirmed',total=$3,expense_id=$4,confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND store_id=$2").bind(id).bind(actor.store_id).bind(total).bind(expense.id).execute(&mut *tx).await?;
    emit(&mut tx,Event{store_id:actor.store_id,actor:Some((actor.member_id,actor.session_id)),typ:"receipt.confirmed",version:1,data:json!({"receipt_id":id,"expense_id":expense.id,"total":total,"line_count":input.lines.len(),"via":via}),change:None}).await?;
    save(&mut tx, &actor, "confirm", &key, &hash, id).await?;
    let row = load(&mut tx, actor.store_id, id).await?;
    let value = response(&mut tx, &state, row).await?;
    tx.commit().await?;
    Ok(Json(value))
}
