//! Products: list, detail, enroll, patch, archive.
use crate::{
    ApiError, ApiResult, AppState,
    auth::Actor,
    catalog::model::{ProductListRow, ProductRow},
    catalog::{enroll, model},
    error::ValidJson,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::time::SystemTime;
use uuid::Uuid;

pub(crate) fn pool(state: &AppState) -> ApiResult<&sqlx::PgPool> {
    state.postgres.as_ref().ok_or_else(ApiError::unavailable)
}

pub(crate) async fn signed_url(
    state: &AppState,
    object_key: &str,
) -> ApiResult<(String, DateTime<Utc>)> {
    match &state.storage {
        Some(storage) => {
            let signed = storage
                .presign_get(object_key, state.image_url_ttl)
                .await
                .map_err(|_| ApiError::unavailable())?;
            Ok((signed.url, signed.expires_at))
        }
        None => Ok((
            format!("https://objects.invalid/{object_key}"),
            (SystemTime::now() + state.image_url_ttl).into(),
        )),
    }
}

pub(crate) async fn images_json(state: &AppState, value: &Value) -> ApiResult<Vec<Value>> {
    let mut images = Vec::new();
    if let Some(entries) = value.as_array() {
        for entry in entries {
            let Some(key) = entry["object_key"].as_str() else {
                continue;
            };
            let (url, expires_at) = signed_url(state, key).await?;
            let mut image = json!({
                "image_id": entry["image_id"].clone(),
                "position": entry["position"].clone(),
                "url": url,
                "url_expires_at": expires_at,
            });
            for field in ["cutout_image_id", "bbox"] {
                if !entry[field].is_null() {
                    image[field] = entry[field].clone();
                }
            }
            images.push(image);
        }
    }
    Ok(images)
}

/// Cost price is Lead-only (matches the sync change feed): others get `null`.
pub(crate) fn product_json(
    lead: bool,
    row: &ProductListRow,
    images: Vec<Value>,
) -> ApiResult<Value> {
    Ok(json!({
        "id": row.product.id,
        "name": row.product.name,
        "price": row.product.price,
        "base_unit": row.product.base_unit,
        "cost_price": row.product.cost_price.filter(|_| lead),
        "barcode": row.product.barcode,
        "category_id": row.product.category_id,
        "units": row.units,
        "images": images,
        "index_status": row.product.index_status,
        "archived": row.product.archived,
        "stock_quantity": row.product.stock_quantity,
        "low_stock_threshold": row.product.low_stock_threshold,
        "stock_status": crate::stock::status(row.product.stock_quantity,row.product.low_stock_threshold.unwrap_or(row.product.store_stock_threshold)),
        "version": row.product.version,
        "created_by": row.product.created_by,
        "updated_at": row.product.updated_at,
    }))
}

async fn load_product(
    conn: &mut PgConnection,
    store_id: Uuid,
    id: Uuid,
) -> ApiResult<Option<ProductListRow>> {
    Ok(
        sqlx::query_as::<_, ProductListRow>(model::PRODUCT_AGG_SELECT)
            .bind(id)
            .bind(store_id)
            .fetch_optional(conn)
            .await?,
    )
}

pub(crate) async fn require_product(
    conn: &mut PgConnection,
    store_id: Uuid,
    id: Uuid,
) -> ApiResult<ProductRow> {
    sqlx::query_as::<_, ProductRow>(model::PRODUCT_SELECT_LOCK)
        .bind(id)
        .bind(store_id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::not_found)
}

#[derive(Debug, Deserialize)]
pub struct ProductListParams {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub category_id: Option<Uuid>,
    #[serde(default)]
    pub include_archived: bool,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    actor: Actor,
    params: Query<ProductListParams>,
    page: crate::pagination::PageParams,
) -> ApiResult<Json<Value>> {
    let mut query = sqlx::QueryBuilder::<sqlx::Postgres>::new("SELECT ");
    query
        .push(model::PRODUCT_FIELDS)
        .push(" , ")
        .push(model::UNITS_JSON)
        .push(" , ")
        .push(model::IMAGES_JSON)
        .push(" FROM products p WHERE p.store_id = ")
        .push_bind(actor.store_id);
    if let Some(q) = &params.q {
        query
            .push(" AND immutable_unaccent(lower(p.name)) LIKE '%' || immutable_unaccent(lower(")
            .push_bind(q.clone())
            .push(")) || '%'");
    }
    if let Some(barcode) = &params.barcode {
        query
            .push(" AND (p.barcode = ")
            .push_bind(barcode.clone())
            .push(" OR EXISTS (SELECT 1 FROM product_units uu WHERE uu.product_id = p.id AND uu.barcode = ")
            .push_bind(barcode.clone())
            .push("))");
    }
    if let Some(category_id) = params.category_id {
        query.push(" AND p.category_id = ").push_bind(category_id);
    }
    if !params.include_archived {
        query.push(" AND NOT p.archived");
    }
    if let Some(cursor) = &page.cursor {
        let id = crate::pagination::decode_cursor::<Uuid>(cursor)?;
        query.push(" AND p.id > ").push_bind(id);
    }
    query
        .push(" ORDER BY p.id LIMIT ")
        .push_bind(i64::from(page.limit) + 1);
    let rows = query
        .build_query_as::<ProductListRow>()
        .fetch_all(pool(&state)?)
        .await?;
    let mut items = Vec::with_capacity(rows.len());
    let mut next_cursor = None;
    let more = rows.len() > page.limit as usize;
    for (index, row) in rows.into_iter().take(page.limit as usize).enumerate() {
        if more && index == (page.limit as usize) - 1 {
            next_cursor = Some(
                crate::pagination::encode_cursor(&row.product.id)
                    .map_err(|_| ApiError::internal())?,
            );
        }
        let images = images_json(&state, &row.images).await?;
        items.push(product_json(
            actor.role == crate::auth::Role::Lead,
            &row,
            images,
        )?);
    }
    Ok(Json(json!({"items": items, "next_cursor": next_cursor})))
}

pub(crate) async fn get_product(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = model::path_id(&id)?;
    let mut conn = pool(&state)?.acquire().await?;
    let row = load_product(&mut conn, actor.store_id, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let images = images_json(&state, &row.images).await?;
    Ok(Json(product_json(
        actor.role == crate::auth::Role::Lead,
        &row,
        images,
    )?))
}

fn unique_violation(error: sqlx::Error) -> ApiError {
    let constraint = match &error {
        sqlx::Error::Database(db) => db.constraint().map(str::to_owned),
        _ => None,
    };
    match constraint.as_deref() {
        Some("products_pkey") => {
            ApiError::conflict("id_conflict", "id already used with a different request")
        }
        Some("products_store_barcode") | Some("product_units_store_barcode") => {
            ApiError::conflict("conflict", "barcode already used")
        }
        _ => ApiError::from(error),
    }
}

async fn load_units(conn: &mut PgConnection, product_id: Uuid) -> ApiResult<Vec<model::UnitRow>> {
    Ok(sqlx::query_as(
        "SELECT id, name, quantity_in_base, price, barcode FROM product_units \
         WHERE product_id = $1 ORDER BY id",
    )
    .bind(product_id)
    .fetch_all(&mut *conn)
    .await?)
}

async fn aggregate_json(
    state: &AppState,
    lead: bool,
    store_id: Uuid,
    id: Uuid,
) -> ApiResult<Value> {
    let mut conn = pool(state)?.acquire().await?;
    let row = load_product(&mut conn, store_id, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let images = images_json(state, &row.images).await?;
    product_json(lead, &row, images)
}

pub(crate) async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(value): ValidJson<Value>,
) -> ApiResult<axum::response::Response> {
    use crate::auth::Action;
    actor.require(Action::EnrollProduct)?;
    let request = model::CreateProductRequest::parse(value.clone())?;
    request.validate()?;
    if request.from_manual_line_id.is_some() {
        // Resolving a flagged line is the Lead's review work.
        actor.require(Action::ReviewQueue)?;
    }
    let hash = crate::idempotency::request_hash(&value);

    // Idempotency is checked before any expensive work: replay returns the stored product.
    let existing: Option<(Uuid, Vec<u8>)> =
        sqlx::query_as("SELECT store_id, request_hash FROM products WHERE id = $1")
            .bind(request.id)
            .fetch_optional(pool(&state)?)
            .await?;
    if let Some((store_id, stored_hash)) = existing {
        if store_id != actor.store_id {
            return Err(ApiError::not_found());
        }
        crate::idempotency::check(&stored_hash, &hash)?;
        return Ok((
            axum::http::StatusCode::OK,
            Json(
                aggregate_json(
                    &state,
                    actor.role == crate::auth::Role::Lead,
                    actor.store_id,
                    request.id,
                )
                .await?,
            ),
        )
            .into_response());
    }

    let embedder = state.embedder.clone().ok_or_else(ApiError::unavailable)?;
    let model_name = embedder.model().to_owned();
    let images = enroll::resolve_images(&state, actor.store_id, &request.image_ids()).await?;
    let mut cutout_ids: Vec<Uuid> = request
        .references
        .iter()
        .flatten()
        .map(|reference| reference.cutout_image_id)
        .collect();
    cutout_ids.sort_unstable();
    cutout_ids.dedup();
    let cutouts = enroll::resolve_images(&state, actor.store_id, &cutout_ids).await?;
    let first_reference = request.references.as_ref().and_then(|refs| refs.first());
    let cutout_key = first_reference
        .and_then(|reference| {
            cutouts
                .iter()
                .find(|image| image.id == reference.cutout_image_id)
        })
        .map(|image| image.object_key.as_str());
    let vector = enroll::embed_reference(
        &state,
        embedder,
        &images[0].object_key,
        cutout_key,
        first_reference.map(|reference| reference.bbox),
    )
    .await?;
    let references = [(images[0].id, vector)];
    if !request.force_new {
        let hits = enroll::duplicate_hits(&state, actor.store_id, &model_name, &references).await?;
        if !hits.is_empty() {
            return Err(enroll::duplicate_error(&state, actor.store_id, hits).await?);
        }
    }

    let mut tx = pool(&state)?.begin().await?;
    if let Some(category_id) = request.category_id {
        let found: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM categories WHERE id = $1 AND store_id = $2")
                .bind(category_id)
                .bind(actor.store_id)
                .fetch_optional(&mut *tx)
                .await?;
        if found.is_none() {
            return Err(ApiError::not_found());
        }
    }
    sqlx::query(
        "INSERT INTO products (id, store_id, name, base_unit, price, cost_price, barcode, \
         category_id, request_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(request.id)
    .bind(actor.store_id)
    .bind(request.name.clone())
    .bind(request.base_unit.clone().unwrap_or_else(|| "cái".into()))
    .bind(request.price)
    .bind(request.cost_price)
    .bind(request.barcode.clone())
    .bind(request.category_id)
    .bind(&hash[..])
    .bind(actor.member_id)
    .execute(&mut *tx)
    .await
    .map_err(unique_violation)?;
    for unit in request.units.iter().flatten() {
        sqlx::query(
            "INSERT INTO product_units (id, store_id, product_id, name, quantity_in_base, price, \
             barcode) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(unit.id)
        .bind(actor.store_id)
        .bind(request.id)
        .bind(&unit.name)
        .bind(unit.quantity_in_base)
        .bind(unit.price)
        .bind(unit.barcode.clone())
        .execute(&mut *tx)
        .await
        .map_err(unique_violation)?;
    }
    for (position, image) in images.iter().enumerate() {
        sqlx::query(
            "INSERT INTO product_images (product_id, image_id, position, cutout_image_id, bbox) VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(request.id)
        .bind(image.id)
        .bind(i16::try_from(position).expect("bounded by validation"))
        .bind(request.references.as_ref().map(|refs| refs[position].cutout_image_id))
        .bind(request.references.as_ref().map(|refs| refs[position].bbox.to_vec()))
        .execute(&mut *tx)
        .await?;
    }
    super::index_jobs::enqueue(&mut tx, actor.store_id, request.id).await?;
    sqlx::query(
        "INSERT INTO price_history (store_id, product_id, field, old_value, new_value, source, \
         changed_by) VALUES ($1,$2,'price',NULL,$3,'manual',$4)",
    )
    .bind(actor.store_id)
    .bind(request.id)
    .bind(request.price)
    .bind(actor.member_id)
    .execute(&mut *tx)
    .await?;
    if let Some(line_id) = request.from_manual_line_id {
        resolve_manual_line(&mut tx, &actor, line_id, request.id).await?;
    }
    if let Some(cost) = request.cost_price {
        sqlx::query(
            "INSERT INTO price_history (store_id, product_id, field, old_value, new_value, source, \
             changed_by) VALUES ($1,$2,'cost_price',NULL,$3,'manual',$4)",
        )
        .bind(actor.store_id)
        .bind(request.id)
        .bind(cost)
        .bind(actor.member_id)
        .execute(&mut *tx)
        .await?;
    }
    crate::events::emit(
        &mut tx,
        crate::events::Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: "catalog.changed",
            version: 1,
            data: json!({"entity": "product", "ids": [request.id]}),
            change: Some(("product", request.id, "upsert")),
        },
    )
    .await?;
    let source = if request.from_manual_line_id.is_some() {
        "review_queue"
    } else if request.references.is_some() {
        "quick_enroll"
    } else {
        "enroll"
    };
    crate::events::emit(&mut tx, crate::events::Event { store_id:actor.store_id, actor:Some(actor.event_actor()),typ:"product.enrolled",version:1,data:json!({"product_id":request.id,"reference_count":request.references.as_ref().map_or_else(||request.image_ids().len(),Vec::len),"source":source}),change:None }).await?;
    // Capture pending before commit makes the job visible to the worker.
    let row = load_product(&mut tx, actor.store_id, request.id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let images = images_json(&state, &row.images).await?;
    let body = product_json(actor.role == crate::auth::Role::Lead, &row, images)?;
    tx.commit().await?;
    Ok((axum::http::StatusCode::CREATED, Json(body)).into_response())
}

/// `from_manual_line_id`: the flagged sale line this product was enrolled from is resolved in
/// the same transaction, exactly as `POST /v1/review/manual-lines/{id}/resolve` with `enrolled`.
async fn resolve_manual_line(
    conn: &mut PgConnection,
    actor: &Actor,
    line_id: Uuid,
    product_id: Uuid,
) -> ApiResult<()> {
    let status: Option<String> = sqlx::query_scalar(
        "SELECT review_status FROM sale_lines \
         WHERE store_id = $1 AND id = $2 AND review_status IS NOT NULL FOR UPDATE",
    )
    .bind(actor.store_id)
    .bind(line_id)
    .fetch_optional(&mut *conn)
    .await?;
    match status.as_deref() {
        None => return Err(ApiError::not_found()),
        Some("open") => {}
        Some(_) => {
            return Err(ApiError::conflict(
                "already_resolved",
                "line already resolved",
            ));
        }
    }
    sqlx::query(
        "UPDATE sale_lines SET review_status = 'resolved', review_action = 'enrolled', \
         review_product_id = $3, reviewed_by = $4, reviewed_at = now() \
         WHERE store_id = $1 AND id = $2",
    )
    .bind(actor.store_id)
    .bind(line_id)
    .bind(product_id)
    .bind(actor.member_id)
    .execute(&mut *conn)
    .await?;
    crate::events::emit(
        conn,
        crate::events::Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: "review.line_resolved",
            version: 1,
            data: json!({"line_id": line_id, "action": "enrolled", "product_id": product_id}),
            change: None,
        },
    )
    .await?;
    Ok(())
}

fn plan_required_action(plan: &model::PatchPlan) -> Option<crate::auth::Action> {
    use crate::auth::Action;
    let price_changed = plan.price.is_some()
        || plan.cost_price.is_some()
        || plan.cost_clear
        // Units carry the prices customers pay, so every insert, update and delete is a
        // price change, not only an update whose price differs.
        || !plan.unit_ops.is_empty();
    if price_changed {
        Some(Action::ChangePrice)
    } else if plan.archived.is_some() {
        Some(Action::ArchiveProduct)
    } else if plan.name.is_some()
        || plan.base_unit.is_some()
        || plan.barcode.is_some()
        || plan.category_id.is_some()
    {
        Some(Action::EnrollProduct)
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
async fn price_changed_event(
    tx: &mut PgConnection,
    actor: &Actor,
    product_id: Uuid,
    unit_id: Option<Uuid>,
    field: &'static str,
    old_value: Value,
    new_value: i64,
    via: &str,
) -> ApiResult<()> {
    crate::events::emit(
        tx,
        crate::events::Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: "price.changed",
            version: 1,
            data: json!({
                "product_id": product_id,
                "unit_id": unit_id,
                "field": field,
                "old_value": old_value,
                "new_value": new_value,
                "source": "manual",
                "via": via,
            }),
            change: None,
        },
    )
    .await?;
    Ok(())
}

async fn history_row(
    tx: &mut PgConnection,
    actor: &Actor,
    product_id: Uuid,
    unit_id: Option<Uuid>,
    field: &str,
    old_value: Option<i64>,
    new_value: i64,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO price_history (store_id, product_id, unit_id, field, old_value, new_value, \
         source, changed_by) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)",
    )
    .bind(actor.store_id)
    .bind(product_id)
    .bind(unit_id)
    .bind(field)
    .bind(old_value)
    .bind(new_value)
    .bind(actor.member_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

async fn catalog_changed_event(
    tx: &mut PgConnection,
    actor: &Actor,
    product_id: Uuid,
) -> ApiResult<()> {
    crate::events::emit(
        tx,
        crate::events::Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: "catalog.changed",
            version: 1,
            data: json!({"entity": "product", "ids": [product_id]}),
            change: Some(("product", product_id, "upsert")),
        },
    )
    .await?;
    Ok(())
}

pub(crate) async fn patch_product(
    State(state): State<AppState>,
    crate::events::Via(via): crate::events::Via,
    actor: Actor,
    Path(id): Path<String>,
    ValidJson(value): ValidJson<Value>,
) -> ApiResult<Json<Value>> {
    let id = model::path_id(&id)?;
    let patch: model::ProductPatch =
        serde_json::from_value(value).map_err(|e| ApiError::validation_failed(e.to_string()))?;
    model::validate_patch(&patch)?;
    if patch.low_stock_threshold.is_some() {
        actor.require(crate::auth::Action::AdjustStock)?;
    }
    let mut tx = pool(&state)?.begin().await?;
    let current = require_product(&mut tx, actor.store_id, id).await?;
    let existing_units = load_units(&mut tx, id).await?;
    let plan = model::plan_patch(&current, &existing_units, patch)?;
    if let Some(action) = plan_required_action(&plan) {
        actor.require(action)?;
    }

    if plan.is_empty() {
        let row = load_product(&mut tx, actor.store_id, id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        let images = images_json(&state, &row.images).await?;
        return Ok(Json(product_json(
            actor.role == crate::auth::Role::Lead,
            &row,
            images,
        )?));
    }

    if let Some(category_id) = plan.category_id
        && let Some(new_id) = category_id
    {
        let found: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM categories WHERE id = $1 AND store_id = $2")
                .bind(new_id)
                .bind(actor.store_id)
                .fetch_optional(&mut *tx)
                .await?;
        if found.is_none() {
            return Err(ApiError::not_found());
        }
    }

    let mut updates = sqlx::QueryBuilder::<sqlx::Postgres>::new("UPDATE products SET ");
    let mut first = true;
    let mut set = |query: &mut sqlx::QueryBuilder<sqlx::Postgres>, clause: &str| {
        if !first {
            query.push(", ");
        }
        first = false;
        query.push(clause);
    };
    if let Some(threshold) = plan.low_stock_threshold {
        set(&mut updates, "low_stock_threshold = ");
        updates.push_bind(threshold);
    }
    if let Some(name) = plan.name.clone() {
        set(&mut updates, "name = ");
        updates.push_bind(name);
    }
    if let Some(base_unit) = plan.base_unit.clone() {
        set(&mut updates, "base_unit = ");
        updates.push_bind(base_unit);
    }
    if let Some(barcode) = plan.barcode.clone() {
        set(&mut updates, "barcode = ");
        updates.push_bind(barcode);
    }
    if let Some(category_id) = plan.category_id {
        set(&mut updates, "category_id = ");
        updates.push_bind(category_id);
    }
    if let Some((old, new)) = plan.price {
        set(&mut updates, "price = ");
        updates.push_bind(new);
        history_row(&mut tx, &actor, id, None, "price", Some(old), new).await?;
        price_changed_event(&mut tx, &actor, id, None, "price", json!(old), new, via).await?;
    }
    if let Some((old, new)) = plan.cost_price {
        set(&mut updates, "cost_price = ");
        updates.push_bind(new);
        history_row(&mut tx, &actor, id, None, "cost_price", old, new).await?;
        price_changed_event(
            &mut tx,
            &actor,
            id,
            None,
            "cost_price",
            old.map(Value::from).unwrap_or(Value::Null),
            new,
            via,
        )
        .await?;
    }
    if plan.cost_clear {
        set(&mut updates, "cost_price = NULL");
    }
    if let Some(archived) = plan.archived {
        set(&mut updates, "archived = ");
        updates.push_bind(archived);
    }
    if !first {
        updates.push(", version = version + 1, updated_at = now() WHERE id = ");
    } else {
        updates.push("version = version + 1, updated_at = now() WHERE id = ");
    }
    updates.push_bind(id);
    updates.push(" AND store_id = ");
    updates.push_bind(actor.store_id);
    updates
        .build()
        .execute(&mut *tx)
        .await
        .map_err(unique_violation)?;

    for op in &plan.unit_ops {
        match op {
            model::UnitOp::Insert(unit) => {
                sqlx::query(
                    "INSERT INTO product_units (id, store_id, product_id, name, \
                     quantity_in_base, price, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                )
                .bind(unit.id)
                .bind(actor.store_id)
                .bind(id)
                .bind(&unit.name)
                .bind(unit.quantity_in_base)
                .bind(unit.price)
                .bind(unit.barcode.clone())
                .execute(&mut *tx)
                .await
                .map_err(unique_violation)?;
            }
            model::UnitOp::Update {
                unit,
                price_changed,
            } => {
                sqlx::query(
                    "UPDATE product_units SET name = $3, quantity_in_base = $4, price = $5, \
                     barcode = $6 WHERE id = $1 AND product_id = $2 AND store_id = $7",
                )
                .bind(unit.id)
                .bind(id)
                .bind(&unit.name)
                .bind(unit.quantity_in_base)
                .bind(unit.price)
                .bind(unit.barcode.clone())
                .bind(actor.store_id)
                .execute(&mut *tx)
                .await
                .map_err(unique_violation)?;
                if let Some((old, new)) = price_changed {
                    history_row(
                        &mut tx,
                        &actor,
                        id,
                        Some(unit.id),
                        "unit_price",
                        Some(*old),
                        *new,
                    )
                    .await?;
                    price_changed_event(
                        &mut tx,
                        &actor,
                        id,
                        Some(unit.id),
                        "unit_price",
                        json!(old),
                        *new,
                        via,
                    )
                    .await?;
                }
            }
            model::UnitOp::Delete(unit_id) => {
                sqlx::query(
                    "DELETE FROM product_units WHERE id = $1 AND product_id = $2 AND store_id = $3",
                )
                .bind(unit_id)
                .bind(id)
                .bind(actor.store_id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    catalog_changed_event(&mut tx, &actor, id).await?;
    let row = load_product(&mut tx, actor.store_id, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let images = images_json(&state, &row.images).await?;
    let body = product_json(actor.role == crate::auth::Role::Lead, &row, images)?;
    tx.commit().await?;
    Ok(Json(body))
}

pub(crate) async fn archive_product(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    use crate::auth::Action;
    actor.require(Action::ArchiveProduct)?;
    let id = model::path_id(&id)?;
    let mut tx = pool(&state)?.begin().await?;
    let current = sqlx::query_as::<_, model::ProductRow>(model::PRODUCT_SELECT_LOCK)
        .bind(id)
        .bind(actor.store_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if !current.archived {
        sqlx::query(
            "UPDATE products SET archived = true, version = version + 1, updated_at = now() \
             WHERE id = $1 AND store_id = $2",
        )
        .bind(id)
        .bind(actor.store_id)
        .execute(&mut *tx)
        .await?;
        catalog_changed_event(&mut tx, &actor, id).await?;
        tx.commit().await?;
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}
