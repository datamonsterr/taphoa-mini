//! Per-product price history, newest first with keyset pagination.
use super::products::pool;
use crate::{ApiError, ApiResult, AppState, auth::Actor, catalog::model};
use axum::{Json, extract::Path, extract::State};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

struct ChangeRow {
    id: Uuid,
    unit_id: Option<Uuid>,
    field: String,
    old_value: Option<i64>,
    new_value: Option<i64>,
    changed_by: Uuid,
    changed_at: DateTime<Utc>,
    source: String,
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for ChangeRow {
    fn from_row(row: &'_ sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(Self {
            id: row.try_get("id")?,
            unit_id: row.try_get("unit_id")?,
            field: row.try_get("field")?,
            old_value: row.try_get("old_value")?,
            new_value: row.try_get("new_value")?,
            changed_by: row.try_get("changed_by")?,
            changed_at: row.try_get("changed_at")?,
            source: row.try_get("source")?,
        })
    }
}

impl ChangeRow {
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "unit_id": self.unit_id,
            "field": self.field,
            "old_value": self.old_value,
            "new_value": self.new_value,
            "changed_by": self.changed_by,
            "changed_at": self.changed_at,
            "source": self.source,
        })
    }
}

async fn fetch_page(
    conn: &mut PgConnection,
    product_id: Uuid,
    limit: u32,
    cursor: Option<(DateTime<Utc>, Uuid)>,
    lead: bool,
) -> ApiResult<Vec<ChangeRow>> {
    let rows = match cursor {
        Some((at, id)) => {
            sqlx::query_as::<_, ChangeRow>(
                "SELECT id, unit_id, field, old_value, new_value, changed_by, changed_at, source \
                 FROM price_history WHERE product_id = $1 AND ($5 OR field <> 'cost_price') AND (changed_at, id) < ($2::timestamptz, $3::uuid) \
                 ORDER BY changed_at DESC, id DESC LIMIT $4",
            )
            .bind(product_id)
            .bind(at)
            .bind(id)
            .bind(i64::from(limit))
            .bind(lead)
            .fetch_all(conn)
            .await?
        }
        None => {
            sqlx::query_as::<_, ChangeRow>(
                "SELECT id, unit_id, field, old_value, new_value, changed_by, changed_at, source \
                 FROM price_history WHERE product_id = $1 AND ($3 OR field <> 'cost_price') \
                 ORDER BY changed_at DESC, id DESC LIMIT $2",
            )
            .bind(product_id)
            .bind(i64::from(limit))
            .bind(lead)
            .fetch_all(conn)
            .await?
        }
    };
    Ok(rows)
}

pub(crate) async fn list(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    page: crate::pagination::PageParams,
) -> ApiResult<Json<Value>> {
    let product_id = model::path_id(&id)?;
    let mut conn = pool(&state)?.acquire().await?;
    let known: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM products WHERE id = $1 AND store_id = $2")
            .bind(product_id)
            .bind(actor.store_id)
            .fetch_optional(&mut *conn)
            .await?;
    if known.is_none() {
        return Err(ApiError::not_found());
    }
    let cursor = match &page.cursor {
        Some(cursor) => {
            let key = crate::pagination::decode_cursor::<(DateTime<Utc>, Uuid)>(cursor)?;
            Some(key)
        }
        None => None,
    };
    let rows = fetch_page(
        &mut conn,
        product_id,
        page.limit + 1,
        cursor,
        actor.role == crate::auth::Role::Lead,
    )
    .await?
    .into_iter();
    let mut items = Vec::with_capacity(rows.len());
    let mut next_cursor = None;
    for (index, row) in rows.enumerate() {
        if index == page.limit as usize {
            next_cursor = Some(
                crate::pagination::encode_cursor(&(row.changed_at, row.id))
                    .map_err(|_| ApiError::internal())?,
            );
            continue;
        }
        items.push(row.json());
    }
    Ok(Json(json!({"items": items, "next_cursor": next_cursor})))
}
