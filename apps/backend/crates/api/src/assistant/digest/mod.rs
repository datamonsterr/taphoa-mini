//! Daily owner summaries, shared by HTTP and the morning scheduler.
mod generate;
pub mod job;
mod template;

pub use generate::generate;

use crate::{
    ApiError, ApiResult, AppState,
    auth::{self, Action, Actor, data::pool},
};
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// Cached Lead view. Cost permission is applied by `view`, never at generation time.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoredDigest {
    pub store_id: Uuid,
    pub business_date: NaiveDate,
    pub generated_at: DateTime<Utc>,
    pub source: String,
    pub model: Option<String>,
    pub summary_vi: String,
    pub payload: Value,
    pub pushed_at: Option<DateTime<Utc>>,
}

async fn stored(
    db: &PgPool,
    store_id: Uuid,
    date: NaiveDate,
) -> Result<Option<StoredDigest>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM assistant_digests WHERE store_id=$1 AND business_date=$2")
        .bind(store_id)
        .bind(date)
        .fetch_optional(db)
        .await
}

pub async fn get_or_generate(
    state: &AppState,
    store_id: Uuid,
    business_date: NaiveDate,
) -> anyhow::Result<StoredDigest> {
    if let Some(digest) = stored(
        pool(state).map_err(|_| anyhow::anyhow!("database unavailable"))?,
        store_id,
        business_date,
    )
    .await?
    {
        return Ok(digest);
    }
    generate(state, store_id, business_date).await
}

pub fn view(stored: &StoredDigest, actor: &Actor, read_at: Option<DateTime<Utc>>) -> Value {
    let mut data = stored.payload.clone();
    if !auth::can(actor, Action::ChangePrice) {
        data["sales"]["gross_profit"] = Value::Null;
        if let Some(items) = data["restock"].as_array_mut() {
            for item in items {
                item["unit_cost"] = Value::Null;
                item["total_cost"] = Value::Null;
            }
        }
    }
    data["business_date"] = json!(stored.business_date);
    data["generated_at"] = json!(stored.generated_at);
    data["source"] = json!(stored.source);
    data["summary_vi"] = json!(stored.summary_vi);
    data["read_at"] = json!(read_at);
    data
}

async fn try_mark_read(
    db: &PgPool,
    store_id: Uuid,
    date: NaiveDate,
    member_id: Uuid,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    let inserted: Option<DateTime<Utc>> = sqlx::query_scalar("INSERT INTO assistant_digest_reads(store_id,business_date,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING read_at")
        .bind(store_id).bind(date).bind(member_id).fetch_optional(db).await?;
    if inserted.is_some() {
        return Ok(None);
    }
    sqlx::query_scalar("SELECT read_at FROM assistant_digest_reads WHERE store_id=$1 AND business_date=$2 AND member_id=$3")
        .bind(store_id).bind(date).bind(member_id).fetch_optional(db).await
}

/// Returns the read timestamp from before this call; None denotes the first open.
pub async fn mark_read(
    pool: &PgPool,
    store_id: Uuid,
    business_date: NaiveDate,
    member_id: Uuid,
) -> Option<DateTime<Utc>> {
    match try_mark_read(pool, store_id, business_date, member_id).await {
        Ok(previous) => previous,
        Err(error) => {
            crate::error::log_sqlx_error!(error, &error, "digest read could not be recorded");
            None
        }
    }
}

/// Stores with refreshed device registrations within `since`.
pub async fn active_store_ids(pool: &PgPool, since: Duration) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT DISTINCT store_id FROM devices WHERE updated_at >= $1")
        .bind(Utc::now() - since)
        .fetch_all(pool)
        .await
}

#[derive(Deserialize)]
pub struct Params {
    business_date: Option<NaiveDate>,
}

#[tracing::instrument(name = "assistant.digest", skip_all, fields(otel.name = "assistant.digest", taphoa.digest.source = tracing::field::Empty))]
pub async fn get(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<Params>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let Query(params) =
        params.map_err(|_| ApiError::validation_failed("invalid digest business_date"))?;
    let today = state.clock.today();
    let date = params.business_date.unwrap_or(today);
    let db = pool(&state)?;
    let digest = if date == today {
        get_or_generate(&state, actor.store_id, date)
            .await
            .map_err(|error| {
                if error.is::<generate::NoActiveMember>() {
                    ApiError::not_found()
                } else {
                    ApiError::internal()
                }
            })?
    } else {
        stored(db, actor.store_id, date)
            .await?
            .ok_or_else(ApiError::not_found)?
    };
    tracing::Span::current().record("taphoa.digest.source", digest.source.as_str());
    let read_at = try_mark_read(db, actor.store_id, date, actor.member_id).await?;
    Ok(Json(view(&digest, &actor, read_at)))
}
