//! Margin-alert state transitions; product locks always precede alert locks.
use super::{event, id, invalid, pool};
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor},
    error::ValidJson,
    events::{Event, emit},
    money,
};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{FromRequest, Path, Query, Request, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

#[derive(Serialize, sqlx::FromRow)]
pub(super) struct Alert {
    id: Uuid,
    product_id: Uuid,
    product_name: Option<String>,
    expense_id: Option<Uuid>,
    cost_price: i64,
    selling_price: i64,
    margin_pct: f64,
    suggested_price: i64,
    status: String,
    created_at: DateTime<Utc>,
}
macro_rules! select_alert {
    ($tail:literal) => { concat!("SELECT a.id,a.product_id,p.name AS product_name,a.expense_id,a.cost_price,a.selling_price,a.margin_pct::float8 AS margin_pct,a.suggested_price,a.status,a.created_at FROM margin_alerts a JOIN products p ON p.id=a.product_id AND p.store_id=a.store_id", $tail) };
}

async fn load(conn: &mut PgConnection, store: Uuid, alert: Uuid) -> ApiResult<Alert> {
    sqlx::query_as(select_alert!(
        " WHERE a.store_id=$1 AND a.id=$2 FOR UPDATE OF a"
    ))
    .bind(store)
    .bind(alert)
    .fetch_optional(conn)
    .await?
    .ok_or_else(ApiError::not_found)
}
pub(super) async fn for_expense(
    conn: &mut PgConnection,
    store: Uuid,
    expense: Uuid,
) -> ApiResult<Vec<Alert>> {
    Ok(sqlx::query_as(select_alert!(
        " WHERE a.store_id=$1 AND a.expense_id=$2 ORDER BY a.created_at,a.id"
    ))
    .bind(store)
    .bind(expense)
    .fetch_all(conn)
    .await?)
}
// Check the shared rule's representable output before calling its infallible i64 API.
fn suggestion(cost: i64, threshold: i64) -> ApiResult<i64> {
    let numerator = i128::from(cost) * (10_000 + i128::from(threshold.max(1000)));
    let rounded = ((numerator + 9_999_999) / 10_000_000) * 1000;
    if rounded > i128::from(i64::MAX) {
        return Err(invalid("suggested price exceeds supported money range"));
    }
    Ok(money::suggested_price(cost, threshold))
}
pub(super) async fn purchase(
    conn: &mut PgConnection,
    actor: &Actor,
    expense: Uuid,
    product: Uuid,
    price: i64,
    cost: i64,
    threshold: i64,
) -> ApiResult<()> {
    if money::margin_below_threshold(price, cost, threshold) {
        // Zero selling price has undefined margin; 0 is the numeric API/DB representation.
        let margin = money::margin_pct(price, cost).unwrap_or(0.0);
        let suggested = suggestion(cost, threshold)?;
        let alert: Uuid = sqlx::query_scalar("INSERT INTO margin_alerts (store_id,product_id,expense_id,cost_price,selling_price,margin_pct,suggested_price) VALUES ($1,$2,$3,$4,$5,$6::float8::numeric,$7) ON CONFLICT (product_id) WHERE status='open' DO UPDATE SET cost_price=EXCLUDED.cost_price,selling_price=EXCLUDED.selling_price,margin_pct=EXCLUDED.margin_pct,suggested_price=EXCLUDED.suggested_price,expense_id=EXCLUDED.expense_id RETURNING id")
            .bind(actor.store_id).bind(product).bind(expense).bind(cost).bind(price).bind(margin).bind(suggested).fetch_one(&mut *conn).await?;
        event(conn, actor, "alert.created", json!({"alert_id":alert,"product_id":product,"cost_price":cost,"selling_price":price,"margin_pct":margin,"suggested_price":suggested})).await?;
    } else {
        let resolved: Option<Uuid> = sqlx::query_scalar("UPDATE margin_alerts SET status='dismissed',resolved_by=$3,resolved_at=now() WHERE store_id=$1 AND product_id=$2 AND status='open' RETURNING id")
            .bind(actor.store_id).bind(product).bind(actor.member_id).fetch_optional(&mut *conn).await?;
        if let Some(alert) = resolved {
            event(
                conn,
                actor,
                "alert.resolved",
                json!({"alert_id":alert,"status":"dismissed","new_price":null}),
            )
            .await?;
        }
    }
    Ok(())
}
#[derive(Deserialize)]
pub(super) struct Filter {
    status: Option<String>,
}
pub(super) async fn list(
    State(state): State<AppState>,
    actor: Actor,
    filter: Result<Query<Filter>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::ViewAlerts)?;
    let Query(filter) = filter.map_err(|_| invalid("invalid alert filter"))?;
    let status = filter.status.as_deref().unwrap_or("open");
    if !["open", "accepted", "dismissed"].contains(&status) {
        return Err(invalid("invalid alert status"));
    }
    let items: Vec<Alert> = sqlx::query_as(select_alert!(
        " WHERE a.store_id=$1 AND a.status=$2 ORDER BY a.created_at DESC,a.id DESC"
    ))
    .bind(actor.store_id)
    .bind(status)
    .fetch_all(pool(&state)?)
    .await?;
    Ok(Json(json!({"items":items})))
}
#[derive(Default, Deserialize)]
struct AcceptInput {
    #[serde(default, deserialize_with = "explicit_price")]
    new_price: Option<i64>,
}
fn explicit_price<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    i64::deserialize(deserializer).map(Some)
}
async fn optional_input(request: Request, state: &AppState) -> ApiResult<AcceptInput> {
    let (parts, body) = request.into_parts();
    let bytes = Bytes::from_request(Request::from_parts(parts.clone(), body), state)
        .await
        .map_err(|_| invalid("invalid alert body"))?;
    if bytes.is_empty() {
        return Ok(AcceptInput::default());
    }
    let ValidJson(input) =
        ValidJson::from_request(Request::from_parts(parts, Body::from(bytes)), state).await?;
    Ok(input)
}
async fn lock_product(conn: &mut PgConnection, store: Uuid, alert: Uuid) -> ApiResult<(Uuid, i64)> {
    let product: Uuid =
        sqlx::query_scalar("SELECT product_id FROM margin_alerts WHERE store_id=$1 AND id=$2")
            .bind(store)
            .bind(alert)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(ApiError::not_found)?;
    let price: i64 =
        sqlx::query_scalar("SELECT price FROM products WHERE store_id=$1 AND id=$2 FOR UPDATE")
            .bind(store)
            .bind(product)
            .fetch_optional(conn)
            .await?
            .ok_or_else(ApiError::not_found)?;
    Ok((product, price))
}
fn require_open(alert: &Alert) -> ApiResult<()> {
    if alert.status != "open" {
        return Err(ApiError::conflict(
            "alert_resolved",
            "alert is no longer open",
        ));
    }
    Ok(())
}
pub(super) async fn accept(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
    request: Request,
) -> ApiResult<Json<Alert>> {
    actor.require(Action::ViewAlerts)?;
    actor.require(Action::ChangePrice)?;
    let input = optional_input(request, &state).await?;
    if input.new_price.is_some_and(|p| p < 0) {
        return Err(invalid("new_price must be non-negative"));
    }
    let alert_id = id(&raw_id)?;
    let mut tx = pool(&state)?.begin().await?;
    let (product, old) = lock_product(&mut tx, actor.store_id, alert_id).await?;
    let alert = load(&mut tx, actor.store_id, alert_id).await?;
    require_open(&alert)?;
    let price = input.new_price.unwrap_or(alert.suggested_price);
    sqlx::query("UPDATE products SET price=$3,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2")
        .bind(actor.store_id).bind(product).bind(price).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO price_history (store_id,product_id,field,old_value,new_value,source,changed_by) VALUES ($1,$2,'price',$3,$4,'margin_alert',$5)")
        .bind(actor.store_id).bind(product).bind(old).bind(price).bind(actor.member_id).execute(&mut *tx).await?;
    event(&mut tx, &actor, "price.changed", json!({"product_id":product,"unit_id":null,"field":"price","old_value":old,"new_value":price,"source":"margin_alert","via":"manual"})).await?;
    emit(
        &mut tx,
        Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: "catalog.changed",
            version: 1,
            data: json!({"entity":"product","ids":[product]}),
            change: Some(("product", product, "upsert")),
        },
    )
    .await?;
    resolve(&mut tx, &actor, alert_id, "accepted", Some(price)).await?;
    let result = load(&mut tx, actor.store_id, alert_id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn resolve(
    conn: &mut PgConnection,
    actor: &Actor,
    alert: Uuid,
    status: &str,
    price: Option<i64>,
) -> ApiResult<()> {
    sqlx::query("UPDATE margin_alerts SET status=$3,resolved_by=$4,resolved_at=now() WHERE store_id=$1 AND id=$2")
        .bind(actor.store_id).bind(alert).bind(status).bind(actor.member_id).execute(&mut *conn).await?;
    event(
        conn,
        actor,
        "alert.resolved",
        json!({"alert_id":alert,"status":status,"new_price":price}),
    )
    .await
}
pub(super) async fn dismiss(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
) -> ApiResult<Json<Alert>> {
    actor.require(Action::ViewAlerts)?;
    let alert_id = id(&raw_id)?;
    let mut tx = pool(&state)?.begin().await?;
    // Same lock order as acceptance and purchase, including when dismiss races a purchase.
    lock_product(&mut tx, actor.store_id, alert_id).await?;
    let alert = load(&mut tx, actor.store_id, alert_id).await?;
    require_open(&alert)?;
    resolve(&mut tx, &actor, alert_id, "dismissed", None).await?;
    let result = load(&mut tx, actor.store_id, alert_id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_price_must_be_an_integer() {
        assert!(
            serde_json::from_value::<AcceptInput>(json!({}))
                .unwrap()
                .new_price
                .is_none()
        );
        assert_eq!(
            serde_json::from_value::<AcceptInput>(json!({"new_price":0}))
                .unwrap()
                .new_price,
            Some(0)
        );
        for input in [
            json!({"new_price":null}),
            json!({"new_price":1.5}),
            json!({"new_price":"1000"}),
        ] {
            assert!(serde_json::from_value::<AcceptInput>(input).is_err());
        }
    }
    #[test]
    fn suggestion_rejects_overflow_and_uses_money_rounding() {
        assert_eq!(suggestion(8500, 1000).unwrap(), 10000);
        assert_eq!(suggestion(8500, 2000).unwrap(), 11000);
        assert!(suggestion(i64::MAX, 1000).is_err());
    }
}
