//! Categories: GET /v1/categories (any member), POST /v1/categories (Lead).
use crate::{
    ApiResult, AppState,
    auth::Action,
    catalog::model,
    error::{ApiError, ValidJson},
    events::{Event, emit},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

#[derive(Deserialize)]
struct CreateCategory {
    id: Uuid,
    name: String,
}

impl CreateCategory {
    fn parse(value: Value) -> ApiResult<Self> {
        serde_json::from_value(value).map_err(|e| ApiError::validation_failed(e.to_string()))
    }
    fn validate(&self) -> ApiResult<()> {
        let length = self.name.chars().count();
        if !(1..=model::CATEGORY_MAX).contains(&length) {
            return Err(ApiError::validation_failed(
                "category name must be 1 to 40 characters",
            ));
        }
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct CategoryRow {
    id: Uuid,
    name: String,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    actor: crate::auth::Actor,
) -> ApiResult<Json<Value>> {
    let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
    let rows: Vec<CategoryRow> =
        sqlx::query_as("SELECT id, name FROM categories WHERE store_id=$1 ORDER BY name")
            .bind(actor.store_id)
            .fetch_all(pool)
            .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| json!({"id": row.id, "name": row.name}))
        .collect();
    Ok(Json(json!({"items": items})))
}

async fn catalog_event(
    tx: &mut PgConnection,
    actor: &crate::auth::Actor,
    id: Uuid,
) -> ApiResult<()> {
    emit(
        tx,
        Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: "catalog.changed",
            version: 1,
            data: json!({"entity": "category", "ids": [id]}),
            change: Some(("category", id, "upsert")),
        },
    )
    .await?;
    Ok(())
}

pub(crate) async fn create(
    State(state): State<AppState>,
    actor: crate::auth::Actor,
    ValidJson(value): ValidJson<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    actor.require(Action::ChangePrice)?;
    let category = CreateCategory::parse(value)?;
    category.validate()?;
    let mut tx = state
        .postgres
        .as_ref()
        .ok_or_else(ApiError::unavailable)?
        .begin()
        .await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT name FROM categories WHERE store_id=$1 AND id=$2")
            .bind(actor.store_id)
            .bind(category.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(name) = existing {
        if name == category.name {
            tx.commit().await?;
            return Ok((
                StatusCode::CREATED,
                Json(json!({"id": category.id, "name": name})),
            ));
        }
        return Err(ApiError::conflict(
            "id_conflict",
            "category id already used with a different name",
        ));
    }
    let duplicate: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM categories WHERE store_id=$1 AND lower(name)=lower($2)")
            .bind(actor.store_id)
            .bind(&category.name)
            .fetch_optional(&mut *tx)
            .await?;
    if duplicate.is_some() {
        return Err(ApiError::conflict(
            "conflict",
            "category name already exists",
        ));
    }
    sqlx::query("INSERT INTO categories (id, store_id, name) VALUES ($1,$2,$3)")
        .bind(category.id)
        .bind(actor.store_id)
        .bind(&category.name)
        .execute(&mut *tx)
        .await
        .map_err(|error| match &error {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                ApiError::conflict("conflict", "category name already exists")
            }
            _ => ApiError::from(error),
        })?;
    catalog_event(&mut tx, &actor, category.id).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id": category.id, "name": category.name})),
    ))
}
