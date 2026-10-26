//! Threads, the message listing and feedback. A thread is visible only to its member in the
//! current store: anyone else gets 404, never 403, so existence does not leak.
//! The row types and `*_json` helpers turn database rows into the `docs/api/openapi.yaml`
//! shapes; the agent loop and the action handlers reuse them.
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Actor, data::pool},
    error::ValidJson,
    pagination::{Page, PageParams, decode_cursor, encode_cursor},
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgExecutor;
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 200;
const MAX_CONTEXT_CHARS: usize = 100;
const MAX_COMMENT_CHARS: usize = 1000;

// The column lists are macros so every query stays a static string; callers append a WHERE.
/// `ThreadRow` columns of `assistant_threads`.
macro_rules! thread_columns {
    () => {
        "id, title, context, created_at, updated_at"
    };
}
/// `MessageRow` select with the caller's feedback joined. Bind the member id as `$1`, then
/// append `WHERE m.store_id=$2 ...`.
macro_rules! message_select {
    () => {
        "SELECT m.id, m.thread_id, m.role, m.content, m.attachments, m.tool_calls, m.cards, \
         m.model, m.created_at, f.rating AS feedback_rating, f.comment AS feedback_comment \
         FROM assistant_messages m \
         LEFT JOIN assistant_feedback f ON f.message_id=m.id AND f.member_id=$1"
    };
}
/// `ActionRow` columns of `assistant_actions`.
macro_rules! action_columns {
    () => {
        "id, thread_id, message_id, kind, status, payload, summary_vi, proposed_by, decided_by, \
         decided_at, result, error, expires_at, created_at, trace_id, span_id"
    };
}
// The agent loop and the action handlers import these; until they land nothing outside this file does.
#[allow(unused_imports)]
pub(crate) use {action_columns, message_select, thread_columns};

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ThreadRow {
    pub(crate) id: Uuid,
    pub(crate) title: Option<String>,
    pub(crate) context: Option<Value>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct MessageRow {
    pub(crate) id: Uuid,
    pub(crate) thread_id: Uuid,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) attachments: Value,
    pub(crate) tool_calls: Value,
    pub(crate) cards: Value,
    pub(crate) model: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) feedback_rating: Option<String>,
    pub(crate) feedback_comment: Option<String>,
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ActionRow {
    pub(crate) trace_id: Option<String>,
    pub(crate) span_id: Option<String>,
    pub(crate) id: Uuid,
    pub(crate) thread_id: Uuid,
    pub(crate) message_id: Uuid,
    pub(crate) kind: String,
    pub(crate) status: String,
    pub(crate) payload: Value,
    pub(crate) summary_vi: String,
    pub(crate) proposed_by: Uuid,
    pub(crate) decided_by: Option<Uuid>,
    pub(crate) decided_at: Option<DateTime<Utc>>,
    pub(crate) result: Option<Value>,
    pub(crate) error: Option<Value>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) created_at: DateTime<Utc>,
}

/// `AssistantThread`.
pub(crate) fn thread_json(row: &ThreadRow) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "context": row.context,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}
/// `AssistantMessage`; `feedback` is the caller's own, with `comment` omitted when empty.
pub(crate) fn message_json(row: &MessageRow) -> Value {
    let feedback = row.feedback_rating.as_ref().map(|rating| {
        let mut feedback = json!({"rating": rating});
        if let Some(comment) = &row.feedback_comment {
            feedback["comment"] = json!(comment);
        }
        feedback
    });
    json!({
        "id": row.id,
        "thread_id": row.thread_id,
        "role": row.role,
        "content": row.content,
        "attachments": row.attachments,
        "tool_calls": row.tool_calls,
        "cards": row.cards,
        "model": row.model,
        "feedback": feedback,
        "created_at": row.created_at,
    })
}
/// `AssistantAction`. Server-only trace and span ids are omitted from the response.
pub(crate) fn action_json(row: &ActionRow) -> Value {
    json!({
        "id": row.id,
        "thread_id": row.thread_id,
        "message_id": row.message_id,
        "kind": row.kind,
        "status": row.status,
        "payload": row.payload,
        "summary_vi": row.summary_vi,
        "proposed_by": row.proposed_by,
        "decided_by": row.decided_by,
        "decided_at": row.decided_at,
        "result": row.result,
        "error": row.error,
        "expires_at": row.expires_at,
        "created_at": row.created_at,
    })
}

pub(crate) fn parse_id(value: &str) -> ApiResult<Uuid> {
    value
        .parse()
        .map_err(|_| ApiError::validation_failed("invalid id"))
}
/// The caller's own thread, or 404.
pub(crate) async fn load_thread(
    db: impl PgExecutor<'_>,
    actor: &Actor,
    id: Uuid,
) -> ApiResult<ThreadRow> {
    sqlx::query_as(concat!(
        "SELECT ",
        thread_columns!(),
        " FROM assistant_threads WHERE store_id=$1 AND member_id=$2 AND id=$3"
    ))
    .bind(actor.store_id)
    .bind(actor.member_id)
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateThread {
    title: Option<String>,
    context: Option<ThreadContext>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThreadContext {
    screen: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_id: Option<Uuid>,
}
impl CreateThread {
    /// The trimmed title, after checking the input against the contract.
    fn validate(&self) -> ApiResult<Option<String>> {
        let title = match self.title.as_deref().map(str::trim) {
            Some("") => return Err(ApiError::validation_failed("title must not be empty")),
            Some(title) if title.chars().count() > MAX_TITLE_CHARS => {
                return Err(ApiError::validation_failed("title is too long"));
            }
            title => title.map(str::to_owned),
        };
        if let Some(context) = &self.context {
            let too_long = |text: &str| text.chars().count() > MAX_CONTEXT_CHARS;
            if context.screen.trim().is_empty() {
                return Err(ApiError::validation_failed("context.screen is required"));
            }
            if too_long(&context.screen) || context.next_step_id.as_deref().is_some_and(too_long) {
                return Err(ApiError::validation_failed("context value is too long"));
            }
        }
        Ok(title)
    }
}

pub(crate) async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ValidJson(input): ValidJson<CreateThread>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let title = input.validate()?;
    let context = input
        .context
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| ApiError::internal())?;
    let row: ThreadRow = sqlx::query_as(concat!(
        "INSERT INTO assistant_threads (id, store_id, member_id, title, context) \
         VALUES ($1, $2, $3, $4, $5) RETURNING ",
        thread_columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(actor.store_id)
    .bind(actor.member_id)
    .bind(title)
    .bind(context)
    .fetch_one(pool(&state)?)
    .await?;
    Ok((StatusCode::CREATED, Json(thread_json(&row))))
}

pub(crate) async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
) -> ApiResult<Json<Page<Value>>> {
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut rows: Vec<ThreadRow> = sqlx::query_as(concat!(
        "SELECT ",
        thread_columns!(),
        " FROM assistant_threads WHERE store_id=$1 AND member_id=$2 \
         AND ($3::timestamptz IS NULL OR (updated_at, id) < ($3, $4)) \
         ORDER BY updated_at DESC, id DESC LIMIT $5"
    ))
    .bind(actor.store_id)
    .bind(actor.member_id)
    .bind(cursor.map(|c| c.0))
    .bind(cursor.map(|c| c.1))
    .bind(i64::from(page.limit) + 1)
    .fetch_all(pool(&state)?)
    .await?;
    let more = rows.len() > page.limit as usize;
    rows.truncate(page.limit as usize);
    let next_cursor = if more {
        rows.last()
            .map(|row| encode_cursor(&(row.updated_at, row.id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    Ok(Json(Page {
        items: rows.iter().map(thread_json).collect(),
        next_cursor,
    }))
}

pub(crate) async fn detail(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&raw_id)?;
    let db = pool(&state)?;
    let thread = load_thread(db, &actor, id).await?;
    let messages: Vec<MessageRow> = sqlx::query_as(concat!(
        message_select!(),
        " WHERE m.store_id=$2 AND m.thread_id=$3 ORDER BY m.created_at, m.id"
    ))
    .bind(actor.member_id)
    .bind(actor.store_id)
    .bind(id)
    .fetch_all(db)
    .await?;
    let actions: Vec<ActionRow> = sqlx::query_as(concat!(
        "SELECT ",
        action_columns!(),
        " FROM assistant_actions WHERE store_id=$1 AND thread_id=$2 ORDER BY created_at, id"
    ))
    .bind(actor.store_id)
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(Json(json!({
        "thread": thread_json(&thread),
        "messages": messages.iter().map(message_json).collect::<Vec<_>>(),
        "actions": actions.iter().map(action_json).collect::<Vec<_>>(),
    })))
}

/// Messages, actions and feedback go with the thread (ON DELETE CASCADE).
pub(crate) async fn delete(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
) -> ApiResult<StatusCode> {
    let deleted =
        sqlx::query("DELETE FROM assistant_threads WHERE store_id=$1 AND member_id=$2 AND id=$3")
            .bind(actor.store_id)
            .bind(actor.member_id)
            .bind(parse_id(&raw_id)?)
            .execute(pool(&state)?)
            .await?
            .rows_affected();
    if deleted == 0 {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Rating {
    Up,
    Down,
}
impl Rating {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FeedbackBody {
    rating: Rating,
    comment: Option<String>,
}

/// Hook for the PostHog LLM feedback events (T8). Runs after the rating is stored.
pub(crate) fn feedback_recorded(
    state: &AppState,
    actor: &Actor,
    message_id: Uuid,
    trace_id: Option<&str>,
    rating: Rating,
    comment: Option<&str>,
) {
    super::telemetry::feedback(state, actor, message_id, trace_id, rating, comment);
}

pub(crate) async fn feedback(
    State(state): State<AppState>,
    actor: Actor,
    Path(raw_id): Path<String>,
    ValidJson(body): ValidJson<FeedbackBody>,
) -> ApiResult<StatusCode> {
    let message_id = parse_id(&raw_id)?;
    let comment = body
        .comment
        .as_deref()
        .map(str::trim)
        .filter(|comment| !comment.is_empty());
    if comment.is_some_and(|comment| comment.chars().count() > MAX_COMMENT_CHARS) {
        return Err(ApiError::validation_failed("comment is too long"));
    }
    let db = pool(&state)?;
    // The join to the thread is the ownership check: another member's message is a 404.
    let (role, trace_id): (String, Option<String>) = sqlx::query_as(
        "SELECT m.role, m.trace_id FROM assistant_messages m \
         JOIN assistant_threads t ON t.id=m.thread_id \
         WHERE m.id=$1 AND m.store_id=$2 AND t.store_id=$2 AND t.member_id=$3",
    )
    .bind(message_id)
    .bind(actor.store_id)
    .bind(actor.member_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(ApiError::not_found)?;
    if role != "assistant" {
        return Err(ApiError::validation_failed(
            "feedback applies to assistant messages",
        ));
    }
    sqlx::query(
        "INSERT INTO assistant_feedback (message_id, member_id, store_id, rating, comment) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (message_id, member_id) DO UPDATE \
         SET rating=EXCLUDED.rating, comment=EXCLUDED.comment, updated_at=now()",
    )
    .bind(message_id)
    .bind(actor.member_id)
    .bind(actor.store_id)
    .bind(body.rating.as_str())
    .bind(comment)
    .execute(db)
    .await?;
    feedback_recorded(
        &state,
        &actor,
        message_id,
        trace_id.as_deref(),
        body.rating,
        comment,
    );
    Ok(StatusCode::NO_CONTENT)
}
