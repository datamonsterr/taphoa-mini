//! Transactional stock ledger shared by checkout, adjustments and receipt confirmation.
//!
//! B5: first call `lock_products(&mut tx, store_id, &all_product_ids)` before
//! emitting any expense or receipt event. Then call
//! `apply(&mut tx, store_id, product_id, Change::Delta(quantity), "receipt",
//! Some(receipt_id), Some(member_id), None)` for each confirmed line. Commit the
//! expense, receipt and stock together in that caller-owned transaction.
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    error::ValidJson,
    events::{Event, emit},
    idempotency::{check, request_hash},
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub enum Change {
    Delta(i32),
    Set(i32),
}
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Movement {
    pub id: Uuid,
    pub delta: i32,
    pub quantity_after: i32,
    pub reason: String,
    pub ref_id: Option<Uuid>,
    pub member_id: Option<Uuid>,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        message,
    )
}
pub fn status(quantity: Option<i32>, threshold: i32) -> &'static str {
    match quantity {
        None => "untracked",
        Some(q) if q <= 0 => "out",
        Some(q) if q <= threshold => "low",
        Some(_) => "ok",
    }
}
/// Acquire every product lock before any stock event in a multi-line sale or
/// receipt confirmation. UUID ordering matches existing purchase writers and
/// prevents opposite line orders from causing deadlocks. Does not commit.
pub async fn lock_products(
    tx: &mut PgConnection,
    store_id: Uuid,
    products: &[Uuid],
) -> ApiResult<()> {
    let mut ids = products.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let locked: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM products WHERE store_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE",
    )
    .bind(store_id)
    .bind(&ids)
    .fetch_all(tx)
    .await?;
    if locked.len() != ids.len() {
        return Err(ApiError::not_found());
    }
    Ok(())
}

/// Locks the product (`FOR UPDATE`) and never commits. Sale/void on an untracked
/// product returns `None` without a ledger row or events. Other changes start at zero.
/// Multi-product callers MUST call [`lock_products`] for their complete set before
/// the first `apply`: `events::emit` subsequently locks the store, matching existing
/// catalog and expense writers' product-before-store lock order.
#[allow(clippy::too_many_arguments)]
pub async fn apply(
    tx: &mut PgConnection,
    store_id: Uuid,
    product_id: Uuid,
    change: Change,
    reason: &str,
    ref_id: Option<Uuid>,
    member_id: Option<Uuid>,
    note: Option<&str>,
    via: Option<&str>,
) -> ApiResult<Option<Movement>> {
    if !matches!(reason, "receipt" | "sale" | "sale_void" | "adjustment")
        || note.is_some_and(|n| n.chars().count() > 200)
    {
        return Err(invalid("invalid stock movement"));
    }
    let (old,name,threshold):(Option<i32>,Option<String>,i32)=sqlx::query_as("SELECT p.stock_quantity,p.name,coalesce(p.low_stock_threshold,s.low_stock_threshold) FROM products p JOIN stores s ON s.id=p.store_id WHERE p.store_id=$1 AND p.id=$2 FOR UPDATE OF p").bind(store_id).bind(product_id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    if old.is_none() && matches!(reason, "sale" | "sale_void") {
        return Ok(None);
    }
    if let Some(member) = member_id {
        let valid: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM members WHERE store_id=$1 AND id=$2)")
                .bind(store_id)
                .bind(member)
                .fetch_one(&mut *tx)
                .await?;
        if !valid {
            return Err(ApiError::not_found());
        }
    }
    let previous = old.unwrap_or(0);
    let quantity = match change {
        Change::Delta(delta) => previous
            .checked_add(delta)
            .ok_or_else(|| invalid("stock overflow"))?,
        Change::Set(count) => count,
    };
    let delta = quantity
        .checked_sub(previous)
        .ok_or_else(|| invalid("stock delta overflow"))?;
    let movement:Movement=sqlx::query_as("INSERT INTO stock_movements(store_id,product_id,delta,quantity_after,reason,ref_id,member_id,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) RETURNING id,delta,quantity_after,reason,ref_id,member_id,note,created_at").bind(store_id).bind(product_id).bind(delta).bind(quantity).bind(reason).bind(ref_id).bind(member_id).bind(note).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE products SET stock_quantity=$3,version=version+1,updated_at=clock_timestamp() WHERE store_id=$1 AND id=$2").bind(store_id).bind(product_id).bind(quantity).execute(&mut *tx).await?;
    let mut data = json!({"product_id":product_id,"stock_quantity":quantity,"reason":reason});
    if reason == "adjustment" {
        data["via"] = json!(via.unwrap_or("manual"));
        if let Some(member_id) = member_id {
            data["member_id"] = json!(member_id);
        }
    }
    emit(
        tx,
        Event {
            store_id,
            actor: None,
            typ: "stock.changed",
            version: 1,
            data,
            change: Some(("product", product_id, "upsert")),
        },
    )
    .await?;
    if previous > threshold && quantity <= threshold {
        emit(tx,Event{store_id,actor:None,typ:"stock.low",version:1,data:json!({"product_id":product_id,"name":name,"stock_quantity":quantity,"threshold":threshold}),change:None}).await?;
    }
    Ok(Some(movement))
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/stock", get(list))
        .route("/v1/products/{productId}/stock-adjustments", post(adjust))
        .route("/v1/products/{productId}/stock-movements", get(movements))
}
#[derive(Deserialize)]
struct Adjustment {
    count: Option<i32>,
    delta: Option<i32>,
    note: Option<String>,
}
async fn adjust(
    State(state): State<AppState>,
    crate::events::Via(via): crate::events::Via,
    actor: Actor,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ValidJson(raw): ValidJson<Value>,
) -> ApiResult<Json<Movement>> {
    actor.require(Action::AdjustStock)?;
    let key = headers
        .get("idempotency-key")
        .and_then(|k| k.to_str().ok())
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| invalid("Idempotency-Key required"))?;
    let key_hash = request_hash(&json!(key));
    let hash = request_hash(&raw);
    let mut tx = pool(&state)?.begin().await?;
    // Serialize this key without locking the store before a product. This also
    // covers a simultaneous reuse of the same key for a different product.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("stock-adjustment:{}:{key}", actor.store_id))
        .execute(&mut *tx)
        .await?;
    let saved:Option<(Uuid,Vec<u8>,Uuid)>=sqlx::query_as("SELECT product_id,request_hash,movement_id FROM stock_adjustment_requests WHERE store_id=$1 AND key_hash=$2").bind(actor.store_id).bind(key_hash.as_slice()).fetch_optional(&mut *tx).await?;
    if let Some((product, stored, movement)) = saved {
        if product != id {
            return Err(ApiError::conflict(
                "id_conflict",
                "key already used for another product",
            ));
        }
        check(&stored, &hash)?;
        return Ok(Json(sqlx::query_as("SELECT id,delta,quantity_after,reason,ref_id,member_id,note,created_at FROM stock_movements WHERE store_id=$1 AND id=$2").bind(actor.store_id).bind(movement).fetch_one(&mut *tx).await?));
    }
    let input: Adjustment =
        serde_json::from_value(raw.clone()).map_err(|e| invalid(e.to_string()))?;
    let change = match (input.count, input.delta) {
        (Some(n), None) if n >= 0 && raw.get("delta").is_none() => Change::Set(n),
        (None, Some(d)) if d != 0 && raw.get("count").is_none() => Change::Delta(d),
        _ => return Err(invalid("provide exactly one of count or delta")),
    };
    if input.note.as_ref().is_some_and(|s| s.chars().count() > 200) {
        return Err(invalid("note exceeds 200 characters"));
    }
    let movement = apply(
        &mut tx,
        actor.store_id,
        id,
        change,
        "adjustment",
        None,
        Some(actor.member_id),
        input.note.as_deref(),
        Some(via),
    )
    .await?
    .ok_or_else(ApiError::internal)?;
    sqlx::query("INSERT INTO stock_adjustment_requests(store_id,key_hash,product_id,request_hash,movement_id) VALUES($1,$2,$3,$4,$5)").bind(actor.store_id).bind(key_hash.as_slice()).bind(id).bind(hash.as_slice()).bind(movement.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(movement))
}
#[derive(Default, Deserialize)]
struct Filters {
    status: Option<String>,
}
#[derive(sqlx::FromRow)]
struct StockRow {
    product_id: Uuid,
    name: Option<String>,
    image_key: Option<String>,
    stock_quantity: i32,
    low_stock_threshold: i32,
    updated_at: DateTime<Utc>,
    rank: i32,
    sort_name: String,
}
async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
    filters: Result<Query<Filters>, QueryRejection>,
) -> ApiResult<Json<Page<Value>>> {
    let filters = filters.map_err(ApiError::from)?.0;
    let status = filters.status.as_deref().unwrap_or("all");
    if !matches!(status, "all" | "low" | "out" | "ok") {
        return Err(ApiError::validation_failed("invalid stock status"));
    }
    let cursor: Option<(i32, String, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut rows:Vec<StockRow>=sqlx::query_as("WITH stock AS (SELECT p.id product_id,p.name,p.stock_quantity,coalesce(p.low_stock_threshold,s.low_stock_threshold) low_stock_threshold,p.updated_at,coalesce(p.name,'') sort_name,CASE WHEN p.stock_quantity<=0 THEN 0 WHEN p.stock_quantity<=coalesce(p.low_stock_threshold,s.low_stock_threshold) THEN 1 ELSE 2 END rank,(SELECT i.object_key FROM product_images pi JOIN images i ON i.id=pi.image_id AND i.store_id=p.store_id WHERE pi.product_id=p.id ORDER BY pi.position,pi.image_id LIMIT 1) image_key FROM products p JOIN stores s ON s.id=p.store_id WHERE p.store_id=$1 AND NOT p.archived AND p.stock_quantity IS NOT NULL) SELECT * FROM stock WHERE ($2='all' OR ($2='low' AND stock_quantity<=low_stock_threshold) OR ($2='out' AND stock_quantity<=0) OR ($2='ok' AND stock_quantity>low_stock_threshold)) AND ($3::int IS NULL OR (rank,sort_name,product_id)>($3,$4,$5)) ORDER BY rank,sort_name,product_id LIMIT $6").bind(actor.store_id).bind(status).bind(cursor.as_ref().map(|c|c.0)).bind(cursor.as_ref().map(|c|c.1.as_str())).bind(cursor.as_ref().map(|c|c.2)).bind(i64::from(page.limit)+1).fetch_all(pool(&state)?).await?;
    let next_cursor = if rows.len() > page.limit as usize {
        rows.pop();
        rows.last()
            .map(|r| encode_cursor(&(r.rank, &r.sort_name, r.product_id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let url = match row.image_key {
            Some(key) => Some(crate::catalog::products::signed_url(&state, &key).await?.0),
            None => None,
        };
        items.push(json!({"product_id":row.product_id,"name":row.name,"image_url":url,"stock_quantity":row.stock_quantity,"low_stock_threshold":row.low_stock_threshold,"status":self::status(Some(row.stock_quantity),row.low_stock_threshold),"updated_at":row.updated_at}));
    }
    Ok(Json(Page { items, next_cursor }))
}
async fn movements(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
    page: PageParams,
) -> ApiResult<Json<Page<Movement>>> {
    let pool = pool(&state)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE store_id=$1 AND id=$2)")
            .bind(actor.store_id)
            .bind(id)
            .fetch_one(pool)
            .await?;
    if !exists {
        return Err(ApiError::not_found());
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut rows:Vec<Movement>=sqlx::query_as("SELECT id,delta,quantity_after,reason,ref_id,member_id,note,created_at FROM stock_movements WHERE store_id=$1 AND product_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5").bind(actor.store_id).bind(id).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(i64::from(page.limit)+1).fetch_all(pool).await?;
    let next_cursor = if rows.len() > page.limit as usize {
        rows.pop();
        rows.last()
            .map(|m| encode_cursor(&(m.created_at, m.id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    Ok(Json(Page {
        items: rows,
        next_cursor,
    }))
}
