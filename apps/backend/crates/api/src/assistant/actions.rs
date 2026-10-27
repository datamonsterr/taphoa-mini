//! Explicit decisions on assistant proposals. Business writes go through the normal router.
use super::telemetry;
use super::threads::{ActionRow, action_columns, action_json, parse_id};
use crate::{
    ApiError, ApiResult, AppState,
    analytics::{ActionDecision, ActionKind, ProductEvent},
    auth::{Action, Actor, data::pool},
    events::{Event, emit},
    idempotency::request_hash,
};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Path, State},
    http::{HeaderMap, Method, Request, StatusCode},
};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgExecutor};
use tower::ServiceExt;
use tracing::Instrument;
use uuid::Uuid;

struct ExecutionError {
    status: StatusCode,
    code: String,
    message: String,
}
impl From<ApiError> for ExecutionError {
    fn from(error: ApiError) -> Self {
        Self {
            status: error.status,
            code: error.code.into(),
            message: error.message,
        }
    }
}
type Execution = Result<Value, ExecutionError>;

const ACTION_NAMESPACE: Uuid = Uuid::from_u128(0x65c5415f_5f12_4c58_934e_95544a1f9425);
fn stale() -> ApiError {
    ApiError::conflict(
        "action_stale",
        "Đề xuất đã hết hạn hoặc dữ liệu đã thay đổi",
    )
}
fn decided() -> ApiError {
    ApiError::conflict("already_decided", "Đề xuất đã được xử lý")
}
fn key(headers: &HeaderMap) -> ApiResult<[u8; 32]> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| ApiError::validation_failed("Idempotency-Key required"))?;
    Ok(request_hash(&json!(key)))
}
async fn load(db: &mut PgConnection, actor: &Actor, id: Uuid) -> ApiResult<ActionRow> {
    sqlx::query_as(concat!("SELECT ",action_columns!()," FROM assistant_actions WHERE store_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM assistant_threads t WHERE t.id=assistant_actions.thread_id AND t.store_id=$1 AND t.member_id=$3) FOR UPDATE"))
        .bind(actor.store_id).bind(id).bind(actor.member_id).fetch_optional(db).await?.ok_or_else(ApiError::not_found)
}
pub(crate) async fn receipt_snapshot(
    db: impl PgExecutor<'_>,
    store: Uuid,
    id: Uuid,
) -> ApiResult<Option<Value>> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('status',r.status,'lines',coalesce((SELECT jsonb_agg(jsonb_build_object('line_id',l.id,'product_id',l.product_id,'quantity',l.quantity,'cost',l.cost) ORDER BY l.position,l.id) FROM receipt_lines l WHERE l.receipt_id=r.id AND l.store_id=r.store_id),'[]'::jsonb)) FROM receipts r WHERE r.store_id=$1 AND r.id=$2")
        .bind(store).bind(id).fetch_optional(db).await?)
}
fn payload_id(payload: &Value, field: &str) -> ApiResult<Uuid> {
    payload[field]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(ApiError::internal)
}
async fn changed(conn: &mut PgConnection, actor: &Actor, row: &ActionRow) -> ApiResult<bool> {
    let p = &row.payload;
    match row.kind.as_str() {
        "stock_adjustment" => Ok(!active_product(conn, actor, payload_id(p, "product_id")?).await?),
        "price_change" | "threshold_update" => {
            let current: Option<(bool,i64,Option<i32>)> = sqlx::query_as("SELECT archived,price,low_stock_threshold FROM products WHERE store_id=$1 AND id=$2")
                .bind(actor.store_id).bind(payload_id(p,"product_id")?).fetch_optional(conn).await?;
            Ok(current.is_none_or(|(archived, price, threshold)| {
                archived
                    || match row.kind.as_str() {
                        "price_change" => json!(price) != p["old_price"],
                        _ => json!(threshold) != p["old_threshold"],
                    }
            }))
        }
        "receipt_line_update" | "receipt_confirm" => {
            let Some(snapshot) =
                receipt_snapshot(&mut *conn, actor.store_id, payload_id(p, "receipt_id")?).await?
            else {
                return Ok(true);
            };
            if snapshot["status"] != "draft" {
                return Ok(true);
            }
            if row.kind == "receipt_confirm" {
                if snapshot["lines"] != p["lines"] {
                    return Ok(true);
                }
                for line in snapshot["lines"].as_array().into_iter().flatten() {
                    if !line["product_id"].is_null()
                        && !active_product(conn, actor, payload_id(line, "product_id")?).await?
                    {
                        return Ok(true);
                    }
                }
            } else {
                let old = snapshot["lines"]
                    .as_array()
                    .and_then(|lines| lines.iter().find(|l| l["line_id"] == p["line_id"]));
                if old != Some(&p["old_line"]) {
                    return Ok(true);
                }
                let new_product = p["new_values"]
                    .get("product_id")
                    .or_else(|| p["old_line"].get("product_id"));
                if let Some(id) = new_product.filter(|id| !id.is_null()) {
                    let id = id
                        .as_str()
                        .and_then(|s| s.parse().ok())
                        .ok_or_else(ApiError::internal)?;
                    if !active_product(conn, actor, id).await? {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        }
        "repayment" | "debt_adjustment" => {
            // A missing or archived customer makes the proposal stale.
            Ok(!sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM customers WHERE store_id=$1 AND id=$2 AND archived_at IS NULL)")
                .bind(actor.store_id).bind(payload_id(p, "customer_id")?).fetch_one(conn).await?)
        }
        "reorder_list" => {
            for item in p["items"].as_array().into_iter().flatten() {
                if !active_product(conn, actor, payload_id(item, "product_id")?).await? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}
async fn active_product(conn: &mut PgConnection, actor: &Actor, id: Uuid) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE store_id=$1 AND id=$2 AND NOT archived)",
    )
    .bind(actor.store_id)
    .bind(id)
    .fetch_one(conn)
    .await?)
}
async fn expire(conn: &mut PgConnection, id: Uuid) -> ApiResult<ActionRow> {
    Ok(sqlx::query_as(concat!(
        "UPDATE assistant_actions SET status='expired' WHERE id=$1 RETURNING ",
        action_columns!()
    ))
    .bind(id)
    .fetch_one(conn)
    .await?)
}

pub(crate) async fn confirm(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let hash = key(&headers)?;
    let id = parse_id(&id)?;
    // Keep a transaction-scoped advisory lock across the dispatch, while committing the
    // executing state separately. Cancellation releases it; another process can recover.
    // No store/product row is held here, so downstream handlers keep their lock order.
    // Bound concurrent confirms first: each holds this connection and needs a second one.
    let _permit = state
        .assistant
        .confirms
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal())?;
    let mut admission = pool(&state)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("assistant-action:{}:{id}", actor.store_id))
        .execute(&mut *admission)
        .await?;
    let mut tx = pool(&state)?.begin().await?;
    let mut row = load(&mut tx, &actor, id).await?;
    let span = telemetry::action_span(&row);
    async move {
        let recovery = row.status == "executing";
        if row.status == "expired" {
            return Err(stale());
        }
        if row.status != "proposed" {
            let stored: Option<Vec<u8>> =
                sqlx::query_scalar("SELECT idempotency_key_hash FROM assistant_actions WHERE id=$1")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            if stored.as_deref() != Some(hash.as_slice()) {
                return Err(decided());
            }
            match row.status.as_str() {
                "done" | "failed" => return Ok(Json(replay_json(&row))),
                "executing" => {}
                _ => return Err(decided()),
            }
        } else {
            if row.expires_at < chrono::Utc::now() || changed(&mut tx, &actor, &row).await? {
                let updated = expire(&mut tx, id).await?;
                tx.commit().await?;
                after_decision(&state, &actor, &updated, ActionDecision::Expired);
                return Err(stale());
            }
            row = sqlx::query_as(concat!("UPDATE assistant_actions SET status='executing',decided_by=$2,decided_at=clock_timestamp(),idempotency_key_hash=$3 WHERE id=$1 RETURNING ",action_columns!()))
                .bind(id).bind(actor.member_id).bind(hash.as_slice()).fetch_one(&mut *tx).await?;
        }
        tx.commit().await?;
        let execution = if recovery && row.kind == "invite" {
            Err(ApiError::conflict(
                "invite_outcome_unknown",
                "Không thể xác định kết quả lời mời trước đó; vui lòng kiểm tra trước khi tạo lại",
            )
            .into())
        } else if matches!(row.kind.as_str(), "receipt_line_update" | "reorder_list") {
            // The assistant-owned write and action finalization share this transaction.
            let mut tx = pool(&state)?.begin().await?;
            let result = owned(&mut tx, &actor, &row).await;
            match result {
                Ok(result) => {
                    let updated = finish(&mut tx, &actor, id, Ok(result)).await?;
                    tx.commit().await?;
                    after_decision(&state, &actor, &updated, ActionDecision::Confirmed);
                    return Ok(Json(action_json(&updated)));
                }
                Err(error) => {
                    tx.rollback().await?;
                    Err(error.into())
                }
            }
        } else {
            execute(state.clone(), actor.clone(), row.clone(), headers).await
        };
        let mut tx = pool(&state)?.begin().await?;
        if execution
            .as_ref()
            .is_err_and(|e| e.status == StatusCode::FORBIDDEN)
        {
            sqlx::query("UPDATE assistant_actions SET status='proposed',decided_by=NULL,decided_at=NULL,idempotency_key_hash=NULL,result=NULL,error=NULL WHERE id=$1")
                .bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            return Err(ApiError::forbidden());
        }
        // The invite secret goes to the confirming caller once and is never stored.
        let mut join_url = None;
        let execution = execution.map(|mut result| {
            if row.kind == "invite" {
                join_url = result.as_object_mut().and_then(|o| o.remove("join_url"));
            }
            result
        });
        let updated = finish(&mut tx, &actor, id, execution).await?;
        tx.commit().await?;
        let decision = if updated.status == "done" {
            ActionDecision::Confirmed
        } else {
            ActionDecision::Failed
        };
        after_decision(&state, &actor, &updated, decision);
        let mut body = action_json(&updated);
        if let Some(url) = join_url {
            body["result"]["join_url"] = url;
        }
        Ok(Json(body))
    }
    .instrument(span)
    .await
}

/// A replay of a decided action. The invite `join_url` is only in the first confirm response.
fn replay_json(row: &ActionRow) -> Value {
    let mut body = action_json(row);
    if row.kind == "invite" && row.status == "done" {
        body["result"]["join_url"] = Value::Null;
        body["result"]["note"] = json!("Liên kết mời chỉ hiển thị một lần khi xác nhận");
    }
    body
}

async fn owned(conn: &mut PgConnection, actor: &Actor, row: &ActionRow) -> ApiResult<Value> {
    let p = &row.payload;
    match row.kind.as_str() {
        "reorder_list" => {
            Ok(json!({"items":p["items"],"supplier":p["supplier"],"total_cost":p["total_cost"]}))
        }
        "receipt_line_update" => {
            actor.require(Action::EnrollProduct)?;
            let receipt = payload_id(p, "receipt_id")?;
            let status: Option<String> = sqlx::query_scalar(
                "SELECT status FROM receipts WHERE store_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(actor.store_id)
            .bind(receipt)
            .fetch_optional(&mut *conn)
            .await?;
            if status.as_deref() != Some("draft") {
                return Err(stale());
            }
            if changed(conn, actor, row).await? {
                return Err(stale());
            }
            let old = &p["old_line"];
            let new = &p["new_values"];
            let product = new.get("product_id").unwrap_or(&old["product_id"]);
            let product: Option<Uuid> = if product.is_null() {
                None
            } else {
                Some(
                    product
                        .as_str()
                        .and_then(|s| s.parse().ok())
                        .ok_or_else(ApiError::internal)?,
                )
            };
            let quantity = new
                .get("quantity")
                .unwrap_or(&old["quantity"])
                .as_i64()
                .and_then(|q| i32::try_from(q).ok())
                .filter(|q| *q > 0)
                .ok_or_else(|| ApiError::validation_failed("invalid quantity"))?;
            let cost = new
                .get("cost")
                .unwrap_or(&old["cost"])
                .as_i64()
                .filter(|c| *c >= 0)
                .ok_or_else(|| ApiError::validation_failed("invalid cost"))?;
            let line = payload_id(p, "line_id")?;
            let affected=sqlx::query("UPDATE receipt_lines SET product_id=$4,quantity=$5,cost=$6 WHERE store_id=$1 AND receipt_id=$2 AND id=$3").bind(actor.store_id).bind(receipt).bind(line).bind(product).bind(quantity).bind(cost).execute(&mut *conn).await?.rows_affected();
            if affected != 1 {
                return Err(stale());
            }
            sqlx::query("UPDATE receipts SET total=(SELECT sum(cost) FROM receipt_lines WHERE receipt_id=$1 AND store_id=$2),updated_at=clock_timestamp() WHERE id=$1 AND store_id=$2").bind(receipt).bind(actor.store_id).execute(conn).await?;
            Ok(json!({"receipt_id":receipt,"line_id":line}))
        }
        _ => Err(ApiError::internal()),
    }
}

// A boxed future breaks the router -> confirm -> router future's recursive Send proof.
fn execute(
    state: AppState,
    actor: Actor,
    row: ActionRow,
    headers: HeaderMap,
) -> BoxFuture<'static, Execution> {
    Box::pin(async move {
        let required = match row.kind.as_str() {
            "stock_adjustment" | "threshold_update" => Some(Action::AdjustStock),
            "expense" => Some(Action::AddExpense),
            "price_change" => Some(Action::ChangePrice),
            "receipt_confirm" => Some(Action::EnrollProduct),
            "invite" => Some(Action::ManageInvites),
            "repayment" => Some(Action::RecordDebt),
            "debt_adjustment" => Some(Action::AdjustDebt),
            _ => None,
        };
        if let Some(action) = required {
            actor.require(action)?;
        }
        let p = &row.payload;
        let derived = Uuid::new_v5(&ACTION_NAMESPACE, row.id.as_bytes());
        let (method, path, body) = match row.kind.as_str() {
            "stock_adjustment" => (
                Method::POST,
                format!(
                    "/v1/products/{}/stock-adjustments",
                    payload_id(p, "product_id")?
                ),
                json!({"delta":p["delta"],"note":p["reason"]}),
            ),
            "expense" => (
                Method::POST,
                "/v1/expenses".into(),
                json!({"id":derived,"spent_at":row.decided_at,"amount":p["amount"],"category":p["category"],"paid_with":p["paid_with"],"note":p["note"]}),
            ),
            "price_change" => (
                Method::PATCH,
                format!("/v1/products/{}", payload_id(p, "product_id")?),
                json!({"price":p["new_price"]}),
            ),
            "threshold_update" => (
                Method::PATCH,
                format!("/v1/products/{}", payload_id(p, "product_id")?),
                json!({"low_stock_threshold":p["threshold"]}),
            ),
            "receipt_confirm" => {
                // The snapshot was checked against the current draft before executing.
                // Reuse those exact lines on recovery so the handler's request hash is stable.
                let lines = p["lines"].as_array().ok_or_else(ApiError::internal)?;
                if lines.iter().any(|l| l["product_id"].is_null()) {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "receipt_unmatched_lines",
                        "Hóa đơn còn dòng chưa khớp sản phẩm",
                    )
                    .into());
                }
                (
                    Method::POST,
                    format!("/v1/receipts/{}/confirm", payload_id(p, "receipt_id")?),
                    json!({"lines":lines,"paid_with":p["paid_with"]}),
                )
            }
            "invite" => (
                Method::POST,
                "/v1/invites".into(),
                json!({"role":p["role"],"can_enroll":p["can_enroll"]}),
            ),
            // The debt endpoints get the action id as idempotency key, so a recovered or
            // replayed confirm returns the same ledger entry.
            "repayment" => (
                Method::POST,
                format!("/v1/customers/{}/repayments", payload_id(p, "customer_id")?),
                json!({"amount":p["amount"],"method":p["method"]}),
            ),
            "debt_adjustment" => (
                Method::POST,
                format!(
                    "/v1/customers/{}/adjustments",
                    payload_id(p, "customer_id")?
                ),
                json!({"amount":p["amount"],"reason":p["reason"]}),
            ),
            _ => return Err(ApiError::validation_failed("Loại đề xuất không được hỗ trợ").into()),
        };
        let content = if method == Method::PATCH {
            "application/merge-patch+json"
        } else {
            "application/json"
        };
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in &headers {
            if ![
                "host",
                "content-length",
                "content-type",
                "idempotency-key",
                "accept",
            ]
            .contains(&name.as_str())
            {
                request = request.header(name, value);
            }
        }
        request = request
            .header("content-type", content)
            .header("x-taphoa-via", "assistant");
        if matches!(
            row.kind.as_str(),
            "stock_adjustment" | "receipt_confirm" | "repayment" | "debt_adjustment"
        ) {
            request = request.header("idempotency-key", derived.to_string());
        }
        let mut request = request
            .body(Body::from(body.to_string()))
            .map_err(|_| ApiError::internal())?;
        request.headers_mut().insert(
            "x-taphoa-via",
            axum::http::HeaderValue::from_static("assistant"),
        );
        let response = crate::router(state)
            .oneshot(request)
            .await
            .map_err(|_| ApiError::internal())?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 8 << 20)
            .await
            .map_err(|_| ApiError::internal())?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::internal())?;
        if !status.is_success() {
            // Preserve handler codes in the failed action without leaking response details.
            return Err(ExecutionError {
                status,
                code: body["code"].as_str().unwrap_or("internal").into(),
                message: body["error"]
                    .as_str()
                    .unwrap_or("Không thể thực hiện đề xuất")
                    .into(),
            });
        }
        let result = match row.kind.as_str() {
            "stock_adjustment" => json!({"movement_id":body["id"]}),
            "expense" => json!({"expense_id":body["id"]}),
            "price_change" | "threshold_update" => json!({"product_id":body["id"]}),
            "receipt_confirm" => json!({"receipt_id":body["id"],"expense_id":body["expense_id"]}),
            "invite" => json!({"expires_at":body["expires_at"],"join_url":body["join_url"]}),
            "repayment" | "debt_adjustment" => json!({"entry_id":body["id"]}),
            _ => return Err(ApiError::internal().into()),
        };
        Ok(result)
    })
}
async fn finish(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    execution: Execution,
) -> ApiResult<ActionRow> {
    let (result, error) = match execution {
        Ok(value) => (Some(value), None),
        Err(error) => (
            None,
            Some(json!({"code":error.code,"message":error.message})),
        ),
    };
    let status = if error.is_some() { "failed" } else { "done" };
    let row: ActionRow = sqlx::query_as(concat!(
        "UPDATE assistant_actions SET status=$2,result=$3,error=$4 WHERE id=$1 RETURNING ",
        action_columns!()
    ))
    .bind(id)
    .bind(status)
    .bind(result)
    .bind(error)
    .fetch_one(&mut *conn)
    .await?;
    if row.status == "done" {
        emit_decision(conn, actor, &row, "confirmed").await?;
    }
    Ok(row)
}
async fn emit_decision(
    conn: &mut PgConnection,
    actor: &Actor,
    row: &ActionRow,
    decision: &str,
) -> ApiResult<()> {
    let mut data = json!({"action_id":row.id,"kind":row.kind,"thread_id":row.thread_id,"decided_by":actor.member_id});
    if decision == "confirmed" {
        // join_url contains the invitation secret; only the owner receives it.
        data["result"] = if row.kind == "invite" {
            json!({"expires_at":row.result.as_ref().and_then(|r|r.get("expires_at"))})
        } else {
            json!(row.result)
        };
    }
    emit(
        conn,
        Event {
            store_id: actor.store_id,
            actor: Some(actor.event_actor()),
            typ: if decision == "confirmed" {
                "assistant.action.confirmed"
            } else {
                "assistant.action.rejected"
            },
            version: 1,
            data,
            change: None,
        },
    )
    .await?;
    Ok(())
}
pub(crate) async fn reject(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut tx = pool(&state)?.begin().await?;
    let row = load(&mut tx, &actor, id).await?;
    let span = telemetry::action_span(&row);
    async move {
        if row.status == "expired" {
            return Err(stale());
        }
        if row.status != "proposed" {
            return Err(decided());
        }
        if row.expires_at < chrono::Utc::now() || changed(&mut tx, &actor, &row).await? {
            let updated = expire(&mut tx, id).await?;
            tx.commit().await?;
            after_decision(&state, &actor, &updated, ActionDecision::Expired);
            return Err(stale());
        }
        let updated:ActionRow=sqlx::query_as(concat!("UPDATE assistant_actions SET status='rejected',decided_by=$2,decided_at=clock_timestamp() WHERE id=$1 RETURNING ",action_columns!())).bind(id).bind(actor.member_id).fetch_one(&mut *tx).await?;
        emit_decision(&mut tx, &actor, &updated, "rejected").await?;
        tx.commit().await?;
        after_decision(&state, &actor, &updated, ActionDecision::Rejected);
        Ok(Json(action_json(&updated)))
    }
    .instrument(span)
    .await
}
pub(crate) fn capture(state: &AppState, actor: &Actor, event: ProductEvent, trace: Option<&str>) {
    telemetry::product(state, actor, &event, trace);
}
fn after_decision(state: &AppState, actor: &Actor, row: &ActionRow, decision: ActionDecision) {
    if let Some(kind) = analytics_kind(&row.kind) {
        capture(
            state,
            actor,
            ProductEvent::AssistantActionDecided { kind, decision },
            row.trace_id.as_deref(),
        );
    }
    let decision = match decision {
        ActionDecision::Confirmed => "confirmed",
        ActionDecision::Rejected => "rejected",
        ActionDecision::Expired => "expired",
        ActionDecision::Failed => "failed",
    };
    action_decided(state, actor, row, decision);
}
/// Record the terminal status on the span enclosing the committed decision.
fn action_decided(_state: &AppState, _actor: &Actor, _row: &ActionRow, decision: &str) {
    tracing::Span::current().record("taphoa.action.status", decision);
}

pub(crate) fn analytics_kind(kind: &str) -> Option<ActionKind> {
    Some(match kind {
        "stock_adjustment" => ActionKind::StockAdjustment,
        "expense" => ActionKind::Expense,
        "price_change" => ActionKind::PriceChange,
        "threshold_update" => ActionKind::ThresholdUpdate,
        "reorder_list" => ActionKind::ReorderList,
        "receipt_line_update" => ActionKind::ReceiptLineUpdate,
        "receipt_confirm" => ActionKind::ReceiptConfirm,
        "invite" => ActionKind::Invite,
        "repayment" => ActionKind::Repayment,
        "debt_adjustment" => ActionKind::DebtAdjustment,
        _ => return None,
    })
}
