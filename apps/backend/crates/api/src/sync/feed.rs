use crate::{
    ApiError, ApiResult, AppState,
    auth::{
        Actor, Role,
        data::{MemberRow, StoreRow, pool},
    },
};
use axum::{
    Json,
    extract::{RawQuery, State},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::HashMap;
use uuid::Uuid;

// The store/sequence predicate uses change_log_store_seq before deduplication.
const FEED_QUERY: &str = "
    SELECT seq, entity, entity_id, op FROM (
        SELECT DISTINCT ON (entity, entity_id) seq, entity, entity_id, op
        FROM change_log WHERE store_id = $1 AND seq > $2
        ORDER BY entity, entity_id, seq DESC
    ) latest ORDER BY seq LIMIT $3";

#[derive(sqlx::FromRow)]
struct ChangeRow {
    seq: i64,
    entity: String,
    entity_id: Uuid,
    op: String,
}

struct Params {
    since: Option<String>,
    seq: i64,
    limit: usize,
}

impl Params {
    fn parse(raw: Option<&str>) -> ApiResult<Self> {
        let pairs: Vec<(String, String)> = serde_urlencoded::from_str(raw.unwrap_or_default())
            .map_err(|_| ApiError::validation_failed("invalid query"))?;
        let mut since = None;
        let mut limit = None;
        for (key, value) in pairs {
            match key.as_str() {
                "since" => {
                    if since.replace(value).is_some() {
                        return Err(ApiError::validation_failed("duplicate since"));
                    }
                }
                "limit" => {
                    if limit.is_some()
                        || value.is_empty()
                        || !value.bytes().all(|b| b.is_ascii_digit())
                    {
                        return Err(ApiError::validation_failed("invalid limit"));
                    }
                    let value: usize = value
                        .parse()
                        .map_err(|_| ApiError::validation_failed("invalid limit"))?;
                    if !(1..=1000).contains(&value) {
                        return Err(ApiError::validation_failed(
                            "limit must be between 1 and 1000",
                        ));
                    }
                    limit = Some(value);
                }
                _ => {}
            }
        }
        let seq = since
            .as_ref()
            .map(|cursor| {
                let invalid = || ApiError::validation_failed("invalid sync cursor");
                let bytes: [u8; 8] = URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(|_| invalid())?
                    .try_into()
                    .map_err(|_| invalid())?;
                let seq = i64::from_be_bytes(bytes);
                if seq < 0 {
                    return Err(invalid());
                }
                Ok(seq)
            })
            .transpose()?
            .unwrap_or(0);
        Ok(Self {
            since,
            seq,
            limit: limit.unwrap_or(500),
        })
    }
}

pub(super) async fn changes(
    actor: Actor,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<Value>> {
    let params = Params::parse(raw.as_deref())?;
    let mut tx = pool(&state)?.begin().await?;
    // Retention and concurrent edits cannot change the snapshot between the floor,
    // change selection, and batched entity reads.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    if params.since.is_some() {
        let floor: Option<i64> =
            sqlx::query_scalar("SELECT floor_seq FROM change_log_floor WHERE store_id=$1")
                .bind(actor.store_id)
                .fetch_optional(&mut *tx)
                .await?;
        if floor.is_some_and(|floor| params.seq < floor) {
            return Err(ApiError::gone());
        }
    }
    let mut rows: Vec<ChangeRow> = sqlx::query_as(FEED_QUERY)
        .bind(actor.store_id)
        .bind(params.seq)
        .bind((params.limit + 1) as i64)
        .fetch_all(&mut *tx)
        .await?;
    let has_more = rows.len() > params.limit;
    rows.truncate(params.limit);
    let cursor = rows
        .last()
        .map(|row| URL_SAFE_NO_PAD.encode(row.seq.to_be_bytes()))
        .unwrap_or_else(|| {
            params
                .since
                .unwrap_or_else(|| URL_SAFE_NO_PAD.encode(0_i64.to_be_bytes()))
        });
    let mut entities = load_entities(&mut tx, &actor, &state, &rows).await?;
    tx.commit().await?;
    let changes: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let data = entities.remove(&(row.entity.clone(), row.entity_id));
            let mut change =
                json!({"seq":row.seq,"entity":row.entity,"op":"delete","id":row.entity_id});
            if row.op != "delete"
                && let Some(data) = data
            {
                change["op"] = json!("upsert");
                change["data"] = data;
            }
            change
        })
        .collect();
    Ok(Json(
        json!({"changes":changes,"cursor":cursor,"has_more":has_more,"server_time":Utc::now()}),
    ))
}

async fn load_entities(
    conn: &mut PgConnection,
    actor: &Actor,
    state: &AppState,
    rows: &[ChangeRow],
) -> ApiResult<HashMap<(String, Uuid), Value>> {
    let ids = |kind: &str| {
        rows.iter()
            .filter(|row| row.entity == kind && row.op != "delete")
            .map(|row| row.entity_id)
            .collect::<Vec<_>>()
    };
    let mut entities = HashMap::new();
    let store_ids = ids("store");
    if !store_ids.is_empty() {
        let stores: Vec<StoreRow> = sqlx::query_as("SELECT id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct::float8 AS margin_threshold_pct,sales_memo_prefix,low_stock_threshold,created_at,version FROM stores WHERE id = ANY($1) AND id=$2")
            .bind(&store_ids).bind(actor.store_id).fetch_all(&mut *conn).await?;
        for row in stores {
            entities.insert(("store".into(), row.id), row.json());
        }
    }
    let member_ids = ids("member");
    if !member_ids.is_empty() {
        let members: Vec<MemberRow> = sqlx::query_as("SELECT id,store_id,display_name,role,can_enroll,pin_hash,active,created_at FROM members WHERE id = ANY($1) AND store_id=$2")
            .bind(&member_ids).bind(actor.store_id).fetch_all(&mut *conn).await?;
        for row in members {
            entities.insert(("member".into(), row.id), row.json());
        }
    }
    let category_ids = ids("category");
    if !category_ids.is_empty() {
        let categories: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id,name FROM categories WHERE id = ANY($1) AND store_id=$2")
                .bind(&category_ids)
                .bind(actor.store_id)
                .fetch_all(&mut *conn)
                .await?;
        for (id, name) in categories {
            entities.insert(("category".into(), id), json!({"id":id,"name":name}));
        }
    }
    let product_ids = ids("product");
    if !product_ids.is_empty() {
        let mut products: Vec<(Uuid, Value)> = sqlx::query_as("SELECT id,jsonb_build_object('id',id,'name',name,'price',price,'base_unit',base_unit,'cost_price',cost_price,'barcode',barcode,'category_id',category_id,'archived',archived,'stock_quantity',stock_quantity,'low_stock_threshold',low_stock_threshold,'stock_status',CASE WHEN stock_quantity IS NULL THEN 'untracked' WHEN stock_quantity<=0 THEN 'out' WHEN stock_quantity<=coalesce(low_stock_threshold,(SELECT s.low_stock_threshold FROM stores s WHERE s.id=products.store_id)) THEN 'low' ELSE 'ok' END,'version',version,'created_by',created_by,'updated_at',updated_at,'units','[]'::jsonb,'images','[]'::jsonb) FROM products WHERE id = ANY($1) AND store_id=$2")
            .bind(&product_ids).bind(actor.store_id).fetch_all(&mut *conn).await?;
        let found_ids: Vec<Uuid> = products.iter().map(|(id, _)| *id).collect();
        if !found_ids.is_empty() {
            let units: Vec<(Uuid, Value)> = sqlx::query_as("SELECT product_id,jsonb_build_object('id',id,'name',name,'quantity_in_base',quantity_in_base,'price',price,'barcode',barcode) FROM product_units WHERE product_id = ANY($1) AND store_id=$2 ORDER BY product_id,id")
                .bind(&found_ids).bind(actor.store_id).fetch_all(&mut *conn).await?;
            let images: Vec<(Uuid, Uuid, i16, String)> = sqlx::query_as("SELECT pi.product_id,pi.image_id,pi.position,i.object_key FROM product_images pi JOIN images i ON i.id=pi.image_id JOIN products p ON p.id=pi.product_id WHERE pi.product_id = ANY($1) AND p.store_id=$2 AND i.store_id=$2 ORDER BY pi.product_id,pi.position")
                .bind(&found_ids).bind(actor.store_id).fetch_all(&mut *conn).await?;
            let mut product_units: HashMap<Uuid, Vec<Value>> = HashMap::new();
            for (id, unit) in units {
                product_units.entry(id).or_default().push(unit);
            }
            let mut product_images: HashMap<Uuid, Vec<Value>> = HashMap::new();
            for (id, image_id, position, key) in images {
                let storage = state.storage.as_ref().ok_or_else(ApiError::unavailable)?;
                let signed = storage
                    .presign_get(&key, state.image_url_ttl)
                    .await
                    .map_err(|error| {
                        tracing::error!(%error, "sync image URL signing failed");
                        ApiError::unavailable()
                    })?;
                product_images.entry(id).or_default().push(json!({"image_id":image_id,"position":position,"url":signed.url,"url_expires_at":signed.expires_at}));
            }
            for (id, data) in &mut products {
                data["units"] = json!(product_units.remove(id).unwrap_or_default());
                data["images"] = json!(product_images.remove(id).unwrap_or_default());
                if actor.role != Role::Lead {
                    data.as_object_mut()
                        .expect("product object")
                        .remove("cost_price");
                }
            }
        }
        for (id, data) in products {
            entities.insert(("product".into(), id), data);
        }
    }
    Ok(entities)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_defaults_and_boundary_cursors_and_limits() {
        let params = Params::parse(None).unwrap();
        assert_eq!((params.seq, params.limit, params.since), (0, 500, None));
        for (seq, limit) in [(0_i64, 1), (i64::MAX, 1000)] {
            let cursor = URL_SAFE_NO_PAD.encode(seq.to_be_bytes());
            let params = Params::parse(Some(&format!("since={cursor}&limit={limit}"))).unwrap();
            assert_eq!((params.seq, params.limit), (seq, limit));
            assert_eq!(params.since.as_deref(), Some(cursor.as_str()));
        }
    }

    #[test]
    fn rejects_invalid_inputs_with_the_api_validation_error() {
        let negative = URL_SAFE_NO_PAD.encode((-1_i64).to_be_bytes());
        for query in [
            "since=",
            "since=AAAA",
            "since=!!!",
            "since=AAAAAAAAAAA=",
            "since=AAAAAAAAAAAA",
            "since=AAAAAAAAAAB",
            "since=AAAAAAAAAAA&since=AAAAAAAAAAA",
            "limit=",
            "limit=-1",
            "limit=0",
            "limit=1001",
            "limit=no",
            "limit=1.0",
            "limit=%2B1",
            "limit=999999999999999999999999999999",
            "limit=1&limit=2",
            &format!("since={negative}"),
        ] {
            let error = Params::parse(Some(query)).err().expect(query);
            assert_eq!(error.code, "validation_failed", "{query}");
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        }
    }
}
