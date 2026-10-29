//! A bounded agent turn: model fallback, parallel permission-checked tools and durable replies.
use super::{
    Language,
    eval::{self, EvalContext},
    grounding,
    model::{ChatMessage, ChatRequest, ChatRole, ModelError, ToolCall, Usage, UsageCost},
    quota::{self, QuotaOutcome},
    stream::{self, Sender, StreamEvent},
    telemetry, threads,
    tools::{ToolContext, ToolError, ToolKind},
};
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Actor, Role, data::pool},
    error::ValidJson,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
};
use chrono::{DateTime, Datelike, NaiveDate, Utc, Weekday};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{Instrument, instrument::WithSubscriber};
use uuid::Uuid;

pub const PROMPT_VERSION: &str = "8";
const VI: &str = include_str!("prompts/system.vi.md");
const EN: &str = include_str!("prompts/system.en.md");
const CONTEXT_MESSAGES: usize = 20;
const TOOL_CHARS: usize = 24_000;
/// Tool calls run per model response; the rest get a `too_many_tool_calls` error.
const MAX_TOOL_CALLS: usize = 8;

#[derive(Debug, Clone)]
pub struct ModelAttempt {
    pub span_id: String,
    pub request: ChatRequest,
    pub content: String,
    pub model: String,
    pub fallback_index: usize,
    pub latency: Duration,
    pub time_to_first_token: Option<Duration>,
    pub http_status: Option<u16>,
    pub usage: Usage,
    pub error: Option<ModelError>,
    pub finish_reason: Option<String>,
}
#[derive(Debug, Clone)]
pub struct ToolRecord {
    pub span_id: String,
    pub name: String,
    pub call_id: String,
    pub kind: Option<ToolKind>,
    pub args: Value,
    pub ok: bool,
    pub denied: bool,
    pub rows: usize,
    /// The tool ran fine and found nothing: no row and no figure other than zero.
    pub empty: bool,
    pub latency: Duration,
    pub summary_vi: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct ToolSummary {
    pub call_id: String,
    pub tool: String,
    pub ok: bool,
    pub summary_vi: String,
}
/// Completed turn data consumed by the asynchronous telemetry hook.
#[derive(Debug, Clone)]
pub struct TurnRecord {
    pub span_id: Option<String>,
    pub input: String,
    pub context: Option<Value>,
    pub latency: Duration,
    pub actor: Actor,
    pub today: NaiveDate,
    pub language: Language,
    pub prompt_version: &'static str,
    pub thread_id: Uuid,
    pub message_id: Uuid,
    pub trace_id: String,
    pub eval: Option<EvalContext>,
    pub attempts: Vec<ModelAttempt>,
    pub tools: Vec<ToolRecord>,
    pub content: String,
    pub transcript: Vec<ChatMessage>,
    pub tool_calls: Vec<ToolSummary>,
    pub cards: Vec<Value>,
    pub model: Option<String>,
    pub usage: Usage,
    pub error: Option<&'static str>,
    /// The grounding guard discarded an ungrounded answer and re-prompted with a system note.
    pub grounding_retry: bool,
}
/// Dispatch telemetry without blocking the reply on the analytics sink.
pub async fn turn_finished(state: &AppState, record: &TurnRecord) {
    telemetry::turn_finished(state, record);
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SendMessage {
    content: String,
    language: Language,
    #[serde(default)]
    attachments: Vec<Attachment>,
}
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Attachment {
    Image(ImageAttachment),
    Receipt(ReceiptAttachment),
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageAttachment {
    image_id: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptAttachment {
    receipt_id: Uuid,
}
fn user_text(content: &str, attachments: &[Attachment]) -> String {
    let mut text = content.to_owned();
    for attachment in attachments {
        match attachment {
            Attachment::Receipt(a) => text.push_str(&format!(
                "\n[đính kèm hóa đơn {}] (receipt_id)",
                a.receipt_id
            )),
            Attachment::Image(a) => {
                text.push_str(&format!("\n[đính kèm ảnh {}] (image_id)", a.image_id))
            }
        }
    }
    text
}

pub(crate) async fn send_message(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    headers: HeaderMap,
    ValidJson(input): ValidJson<SendMessage>,
) -> ApiResult<impl IntoResponse> {
    if !(1..=4000).contains(&input.content.chars().count()) {
        return Err(ApiError::validation_failed(
            "content must contain 1 to 4000 characters",
        ));
    }
    let thread_id = threads::parse_id(&id)?;
    let db = pool(&state)?;
    let thread = threads::load_thread(db, &actor, thread_id).await?;
    for attachment in &input.attachments {
        let (query, id) = match attachment {
            Attachment::Image(a) => (
                "SELECT EXISTS(SELECT 1 FROM images WHERE store_id=$1 AND id=$2)",
                a.image_id,
            ),
            Attachment::Receipt(a) => (
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE store_id=$1 AND id=$2)",
                a.receipt_id,
            ),
        };
        if !sqlx::query_scalar::<_, bool>(query)
            .bind(actor.store_id)
            .bind(id)
            .fetch_one(db)
            .await?
        {
            return Err(ApiError::not_found());
        }
    }
    let eval = eval::from_headers(&headers, &state.assistant.config);
    let today = eval
        .as_ref()
        .map_or_else(|| state.clock.today(), |e| e.today);
    let store_name: String = sqlx::query_scalar("SELECT name FROM stores WHERE id=$1")
        .bind(actor.store_id)
        .fetch_one(db)
        .await?;
    let mut history: Vec<HistoryMessage> = sqlx::query_as("SELECT role,content,attachments,transcript,created_at FROM assistant_messages WHERE store_id=$1 AND thread_id=$2 AND status<>'streaming' ORDER BY created_at DESC,id DESC LIMIT 21")
        .bind(actor.store_id).bind(thread_id).fetch_all(db).await?;
    history.reverse();
    let previous_user = history
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.created_at);
    let notes: Vec<(String, String)> = sqlx::query_as("SELECT summary_vi,status FROM assistant_actions WHERE store_id=$1 AND thread_id=$2 AND status IN ('done','rejected') AND ($3::timestamptz IS NULL OR decided_at>$3) ORDER BY decided_at,id")
        .bind(actor.store_id).bind(thread_id).bind(previous_user).fetch_all(db).await?;
    let mut messages = build_context(
        &store_name,
        &actor,
        today,
        input.language,
        thread.context.as_ref(),
        history,
        notes,
    );
    messages.push(ChatMessage::user(user_text(
        &input.content,
        &input.attachments,
    )));
    let user_id = Uuid::now_v7();
    let message_id = Uuid::now_v7();
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO assistant_messages(id,thread_id,store_id,role,content,attachments) VALUES($1,$2,$3,'user',$4,$5)")
        .bind(user_id).bind(thread_id).bind(actor.store_id).bind(&input.content).bind(json!(input.attachments)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO assistant_messages(id,thread_id,store_id,role,content,status) VALUES($1,$2,$3,'assistant','','streaming')")
        .bind(message_id).bind(thread_id).bind(actor.store_id).execute(&mut *tx).await?;
    tx.commit().await?;
    let (tx, rx) = mpsc::unbounded_channel();
    let span = telemetry::invoke_span(thread_id, thread.context.as_ref());
    let trace_id = telemetry::trace_id(&span);
    let language = input.language;
    let guard = (state.clone(), tx.clone());
    let turn = tokio::spawn(
        async move {
            crate::telemetry::record_identity(&actor);
            stream::send(
                &tx,
                StreamEvent::Created {
                    message_id,
                    thread_id,
                },
            );
            let ctx = ToolContext {
                state: state.clone(),
                actor,
                today,
                language: input.language,
                thread_id,
                message_id,
                trace_id: Some(trace_id),
            };
            let mut record = run_turn(&ctx, eval, messages, &tx).await;
            record.context = thread.context;
            tracing::Span::current().record(
                "taphoa.assistant.use_cases",
                telemetry::use_cases(record.tools.iter().map(|t| t.name.as_str())).join(","),
            );
            if persist(&state, &record).await.is_err() {
                record.error = Some("internal");
                mark_failed(&state, message_id).await;
            }
            turn_finished(&state, &record).await;
            if let Some(code) = record.error {
                stream::send(
                    &tx,
                    StreamEvent::Error {
                        code,
                        message_vi: error_text(code, input.language).into(),
                    },
                );
            } else {
                stream::send(
                    &tx,
                    StreamEvent::Completed {
                        message_id,
                        model: record.model.unwrap_or_default(),
                        usage: record.usage,
                    },
                );
            }
        }
        .instrument(span)
        .with_current_subscriber(),
    );
    // A panic in the turn must not leave the assistant row `streaming`.
    tokio::spawn(async move {
        if turn.await.is_err() {
            let (state, tx) = guard;
            mark_failed(&state, message_id).await;
            stream::send(
                &tx,
                StreamEvent::Error {
                    code: "internal",
                    message_vi: error_text("internal", language).into(),
                },
            );
        }
    });
    Ok(stream::response(rx))
}

#[derive(sqlx::FromRow)]
struct HistoryMessage {
    role: String,
    content: String,
    attachments: Value,
    transcript: Value,
    created_at: DateTime<Utc>,
}
fn render_prompt(
    store: &str,
    role: Role,
    today: NaiveDate,
    language: Language,
    context: Option<&Value>,
) -> String {
    let weekday = match today.weekday() {
        Weekday::Mon => "Thứ Hai",
        Weekday::Tue => "Thứ Ba",
        Weekday::Wed => "Thứ Tư",
        Weekday::Thu => "Thứ Năm",
        Weekday::Fri => "Thứ Sáu",
        Weekday::Sat => "Thứ Bảy",
        Weekday::Sun => "Chủ nhật",
    };
    let date = format!(
        "{today} ({})",
        if language == Language::Vi {
            weekday.to_owned()
        } else {
            today.format("%A").to_string()
        }
    );
    let role = match (role, language) {
        (Role::Lead, Language::Vi) => "Chủ cửa hàng",
        (Role::Seller, Language::Vi) => "Người bán",
        (Role::Lead, Language::En) => "Store owner",
        (Role::Seller, Language::En) => "Seller",
    };
    let screen = context.and_then(|c| c["screen"].as_str()).unwrap_or("chat");
    // Substitute template segments once, so braces in store data are left alone.
    let template = if language == Language::Vi { VI } else { EN };
    let vars = [
        ("{store_name}", store),
        ("{role}", role),
        ("{today}", date.as_str()),
        ("{language}", language.as_str()),
        ("{screen}", screen),
    ];
    let mut out = String::new();
    let mut rest = template;
    while let Some((index, key, value)) = vars
        .iter()
        .filter_map(|(key, value)| rest.find(key).map(|i| (i, *key, *value)))
        .min_by_key(|(i, _, _)| *i)
    {
        out.push_str(&rest[..index]);
        out.push_str(value);
        rest = &rest[index + key.len()..];
    }
    out.push_str(rest);
    if let Some(yesterday) = today.pred_opt() {
        out.push_str(&format!("\nHôm qua (yesterday): {yesterday}."));
    }
    for days in [30, 60] {
        if let Some(from) = today.checked_sub_days(chrono::Days::new(days - 1)) {
            out.push_str(&format!(
                "\n{days} ngày gần nhất / last {days} days (inclusive): {from}..{today}."
            ));
        }
    }
    for key in ["receipt_id", "image_id"] {
        if let Some(id) = context.and_then(|c| c[key].as_str()) {
            let label = if key == "image_id" {
                "ảnh"
            } else {
                "hóa đơn"
            };
            out.push_str(&format!("\n[đính kèm {label} {id}] ({key})"));
        }
    }
    out
}
fn build_context(
    store: &str,
    actor: &Actor,
    today: NaiveDate,
    language: Language,
    context: Option<&Value>,
    history: Vec<HistoryMessage>,
    notes: Vec<(String, String)>,
) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage::system(render_prompt(
        store, actor.role, today, language, context,
    ))];
    let drop = history.len().saturating_sub(CONTEXT_MESSAGES);
    let long = drop > 0;
    for row in history.into_iter().skip(drop) {
        if row.role == "user" {
            let attachments =
                serde_json::from_value::<Vec<Attachment>>(row.attachments).unwrap_or_default();
            messages.push(ChatMessage::user(user_text(&row.content, &attachments)));
        } else {
            let transcript =
                serde_json::from_value::<Vec<ChatMessage>>(row.transcript).unwrap_or_default();
            // Final text is stored in content. Replay the tool exchange without duplicating it.
            messages.extend(
                transcript
                    .into_iter()
                    .filter(|m| {
                        m.role == ChatRole::Tool
                            || (m.role == ChatRole::Assistant && !m.tool_calls.is_empty())
                    })
                    .map(mark_previous_turn),
            );
            if !row.content.is_empty() {
                messages.push(ChatMessage::assistant(Some(row.content), vec![]));
            }
        }
    }
    trim_tool_results(&mut messages, long);
    if !notes.is_empty() {
        let note = notes
            .iter()
            .map(|(summary, status)| {
                format!(
                    "Ghi chú hệ thống: đề xuất {summary} {}.",
                    if status == "done" {
                        "đã được xác nhận"
                    } else {
                        "bị từ chối"
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        messages.push(ChatMessage::system(note));
    }
    messages
}
/// Tool results replayed from earlier turns are labelled old so the model fetches fresh numbers.
fn mark_previous_turn(mut message: ChatMessage) -> ChatMessage {
    if message.role == ChatRole::Tool {
        let raw = message.content.take().unwrap_or_default();
        let data = if serde_json::from_str::<Value>(&raw).is_ok() {
            raw
        } else {
            Value::String(raw).to_string()
        };
        message.content = Some(format!(r#"{{"from_previous_turn":true,"data":{data}}}"#));
    }
    message
}
#[cfg(test)]
use super::grounding::numbers;
#[cfg(test)]
fn contains_store_numbers(text: &str) -> bool {
    !numbers(text, true).is_empty()
}
/// Only current-turn tool results and user figures back a reply; model-generated read
/// arguments are requests, not evidence.
fn unmatched_numbers(record: &TurnRecord, answer: &str) -> Vec<f64> {
    grounding::unmatched_numbers(
        &record.input,
        record
            .transcript
            .iter()
            .filter(|m| m.role == ChatRole::Tool)
            .filter_map(|m| m.content.as_deref()),
        answer,
    )
}
fn has_ungrounded_number(record: &TurnRecord, answer: &str) -> bool {
    !unmatched_numbers(record, answer).is_empty()
}
fn ungrounded_text(language: Language) -> &'static str {
    if language == Language::Vi {
        "Mình chưa lấy được số liệu để trả lời chính xác. Bạn thử hỏi lại nhé."
    } else {
        "I could not fetch the figures to answer accurately. Please ask again."
    }
}
/// True when a tool result holds nothing to report: no non-zero number and no non-empty text
/// below the top level (dates and echoed arguments are text, so strings do not count).
fn data_is_empty(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64().is_none_or(|v| v == 0.0),
        Value::Array(items) => items.iter().all(data_is_empty),
        Value::Object(map) => map.values().all(data_is_empty),
        _ => true,
    }
}
/// Every read tool of the turn ran fine and found nothing (a missing product, a period without
/// sales): the answer is "no data", not a failure the seller should retry.
fn found_nothing(record: &TurnRecord) -> bool {
    let mut reads = record
        .tools
        .iter()
        .filter(|t| t.ok && t.kind == Some(ToolKind::Read))
        .peekable();
    reads.peek().is_some() && reads.all(|t| t.empty)
}
fn no_data_text(language: Language) -> &'static str {
    if language == Language::Vi {
        "Cửa hàng của bạn chưa có số liệu cho yêu cầu này. Mình chỉ xem được dữ liệu của cửa hàng này. Bạn thử kỳ khác hoặc tên khác nhé."
    } else {
        "Your store has no data for this request. I can only see this store's data. Try another period or name."
    }
}
/// The closing text when the grounding guard drops the model's answer.
fn guard_text(record: &TurnRecord, language: Language) -> &'static str {
    if found_nothing(record) {
        no_data_text(language)
    } else {
        ungrounded_text(language)
    }
}
/// A successful propose call ends the guard: the turn is about that action, not store figures.
fn has_proposal(record: &TurnRecord) -> bool {
    record
        .tools
        .iter()
        .any(|t| t.ok && t.kind == Some(ToolKind::Propose))
}
fn collect_text_calls(
    value: &Value,
    out: &mut Vec<(String, Value)>,
    known: &dyn Fn(&str) -> bool,
) -> bool {
    match value {
        Value::Array(items) => items.iter().all(|v| collect_text_calls(v, out, known)),
        Value::Object(map) => {
            let Some(name) = map.get("name").and_then(Value::as_str).filter(|n| known(n)) else {
                return false;
            };
            let Some(args) = map.get("parameters").or_else(|| map.get("arguments")) else {
                return false;
            };
            out.push((name.to_owned(), args.clone()));
            true
        }
        _ => false,
    }
}
/// Some free models emit a tool call as plain text (`[[{"name":..,"parameters":{..}}]]`) instead of
/// `tool_calls`. Content that is entirely such calls to known tools becomes those calls.
fn parse_text_tool_calls(
    content: &str,
    known: &dyn Fn(&str) -> bool,
    already: usize,
) -> Option<Vec<ToolCall>> {
    let trimmed = content.trim();
    if !(trimmed.starts_with('[') || trimmed.starts_with('{')) {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let mut found = vec![];
    if !collect_text_calls(&value, &mut found, known) || found.is_empty() {
        return None;
    }
    Some(
        found
            .into_iter()
            .enumerate()
            .map(|(i, (name, args))| ToolCall {
                id: format!("text_call_{}", already + i + 1),
                name,
                arguments: match args {
                    Value::String(raw) => raw,
                    other => other.to_string(),
                },
            })
            .collect(),
    )
}
fn trim_tool_results(messages: &mut [ChatMessage], long: bool) {
    let mut chars: usize = messages
        .iter()
        .filter(|m| m.role == ChatRole::Tool)
        .map(|m| m.content.as_deref().unwrap_or_default().chars().count())
        .sum();
    for message in messages.iter_mut().filter(|m| m.role == ChatRole::Tool) {
        if chars <= TOOL_CHARS && !long {
            break;
        }
        if message.content.as_deref() == Some(r#"{"omitted":true}"#) {
            continue;
        }
        chars = chars.saturating_sub(
            message
                .content
                .as_deref()
                .unwrap_or_default()
                .chars()
                .count(),
        );
        message.content = Some(r#"{"omitted":true}"#.into());
        chars += r#"{"omitted":true}"#.len();
        // A long history discards its oldest tool result even when below the character cap.
        if chars <= TOOL_CHARS {
            break;
        }
    }
}
fn error_text(code: &str, language: Language) -> &'static str {
    match (code, language) {
        ("quota", Language::Vi) => "Cửa hàng đã hết lượt trợ lý hôm nay. Bạn thử lại ngày mai nhé.",
        ("quota", Language::En) => {
            "The assistant's daily quota is used up. Please try again tomorrow."
        }
        ("timeout", Language::Vi) => "Trợ lý phản hồi quá lâu. Bạn thử lại sau nhé.",
        ("timeout", Language::En) => "The assistant timed out. Please try again later.",
        ("internal", Language::Vi) => "Không thể lưu câu trả lời. Bạn thử lại sau nhé.",
        ("internal", Language::En) => "The reply could not be saved. Please try again later.",
        (_, Language::Vi) => "Trợ lý đang không khả dụng. Bạn thử lại sau nhé.",
        (_, Language::En) => "The assistant is unavailable. Please try again later.",
    }
}
fn text(record: &mut TurnRecord, tx: &Sender, value: String) {
    record.content.push_str(&value);
    stream::send(tx, StreamEvent::Delta { text: value });
}

/// Runs independently of the HTTP body: sending into a closed channel is harmless.
pub async fn run_turn(
    ctx: &ToolContext,
    eval: Option<EvalContext>,
    messages: Vec<ChatMessage>,
    tx: &Sender,
) -> TurnRecord {
    let started = Instant::now();
    let mut record = run_turn_inner(ctx, eval, messages, tx).await;
    record.latency = started.elapsed();
    record
}
async fn run_turn_inner(
    ctx: &ToolContext,
    eval: Option<EvalContext>,
    mut messages: Vec<ChatMessage>,
    tx: &Sender,
) -> TurnRecord {
    let state = &ctx.state;
    let config = &state.assistant.config;
    let mut record = TurnRecord {
        span_id: telemetry::span_id(&tracing::Span::current()),
        input: messages
            .iter()
            .rev()
            .find(|m| m.role == ChatRole::User)
            .and_then(|m| m.content.clone())
            .unwrap_or_default(),
        context: None,
        latency: Duration::ZERO,
        actor: ctx.actor.clone(),
        today: ctx.today,
        language: ctx.language,
        prompt_version: PROMPT_VERSION,
        thread_id: ctx.thread_id,
        message_id: ctx.message_id,
        trace_id: ctx
            .trace_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().simple().to_string()),
        eval,
        attempts: vec![],
        tools: vec![],
        content: String::new(),
        transcript: vec![],
        tool_calls: vec![],
        cards: vec![],
        model: None,
        usage: Usage::default(),
        error: None,
        grounding_retry: false,
    };
    if super::policy::seller_day_close(ctx.actor.role, &record.input) {
        let reply = match ctx.language {
            Language::Vi => {
                "Số liệu chốt sổ, tiền kiểm quỹ và chênh lệch quỹ chỉ chủ cửa hàng được xem. Em hỏi trực tiếp chủ cửa hàng nhé."
            }
            Language::En => {
                "Only the store owner can view day-close and cash reconciliation figures. Please ask the owner."
            }
        };
        record.model = Some("policy".into());
        record.usage.cost = Some(UsageCost {
            input_usd: Some(0.0),
            output_usd: Some(0.0),
            total_usd: 0.0,
        });
        record
            .transcript
            .push(ChatMessage::assistant(Some(reply.into()), vec![]));
        text(&mut record, tx, reply.into());
        return record;
    }
    let openrouter_exhausted = config
        .free_quota_applies(record.eval.as_ref().and_then(|e| e.model.as_deref()))
        && quota::openrouter_exhausted(state).await;
    let quota = if openrouter_exhausted {
        Ok(QuotaOutcome::Exceeded)
    } else if record.eval.is_some() {
        Ok(QuotaOutcome::Allowed { used: 0 })
    } else {
        quota::take_message(
            state,
            ctx.actor.store_id,
            ctx.today,
            config.daily_messages_per_store,
        )
        .await
    };
    match quota {
        Ok(QuotaOutcome::Exceeded) => {
            telemetry::quota_hit(
                state,
                &ctx.actor,
                &record.trace_id,
                ctx.thread_id,
                record.eval.as_ref(),
                if openrouter_exhausted {
                    "openrouter"
                } else {
                    "store"
                },
            );
            record.error = Some("quota");
            text(&mut record, tx, error_text("quota", ctx.language).into());
            return record;
        }
        Err(_) => {
            record.error = Some("internal");
            return record;
        }
        _ => {}
    }
    let Some(model) = &state.assistant.model else {
        record.error = Some("model_unavailable");
        return record;
    };
    let models = record
        .eval
        .as_ref()
        .and_then(|e| e.model.as_ref())
        .map_or_else(|| config.models.clone(), |id| vec![id.clone()]);
    if models.is_empty() {
        record.error = Some("model_unavailable");
        return record;
    }
    let max_calls = config.max_model_calls.min(6);
    let mut first_model_index = 0;
    let mut received_response = false;
    while record.attempts.len() < max_calls {
        let mut answer = None;
        let mut all_timeouts = true;
        // Until a proposal succeeds, text is held back so an answer with unbacked figures never reaches the user.
        let buffering = !has_proposal(&record);
        for (index, id) in models.iter().enumerate().skip(first_model_index) {
            if record.attempts.len() >= max_calls {
                break;
            }
            trim_tool_results(&mut messages, false);
            let request = ChatRequest {
                model: id.clone(),
                messages: messages.clone(),
                tools: state.assistant.registry.specs_for(&ctx.actor),
                max_tokens: 2048,
                reasoning_effort: Some(config.reasoning_effort.clone()),
                tool_choice: (record.grounding_retry && !record.tools.iter().any(|t| t.ok))
                    .then(|| "required".into()),
            };
            let (deltas, mut rx) = mpsc::unbounded_channel();
            let started = Instant::now();
            let span = telemetry::chat_span(id, index, model.server_address());
            let attempt_span_id =
                telemetry::span_id(&span).unwrap_or_else(|| Uuid::new_v4().simple().to_string());
            let call = model.chat(&request, &deltas).instrument(span.clone());
            tokio::pin!(call);
            let mut emitted = false;
            let mut first_token = None;
            let mut attempt_content = String::new();
            let mut held = String::new();
            let result = loop {
                tokio::select! {
                    delta = rx.recv() => if let Some(delta) = delta {
                        first_token.get_or_insert_with(||started.elapsed());
                        emitted |= !delta.is_empty(); attempt_content.push_str(&delta);
                        if buffering { held.push_str(&delta) } else { text(&mut record,tx,delta) }
                    },
                    result = &mut call => break result,
                }
            };
            while let Ok(delta) = rx.try_recv() {
                first_token.get_or_insert_with(|| started.elapsed());
                emitted |= !delta.is_empty();
                attempt_content.push_str(&delta);
                if buffering {
                    held.push_str(&delta);
                } else {
                    text(&mut record, tx, delta);
                }
            }
            let mut attempt = ModelAttempt {
                span_id: attempt_span_id,
                request: request.clone(),
                content: attempt_content,
                model: id.clone(),
                fallback_index: index,
                latency: started.elapsed(),
                time_to_first_token: first_token,
                http_status: None,
                usage: Usage::default(),
                error: None,
                finish_reason: None,
            };
            if let Ok(response) = &result {
                attempt.model = response.model.clone();
                attempt.content = response.content.clone();
                attempt.http_status = Some(response.http_status);
                attempt.usage = response.usage;
                attempt.time_to_first_token = response.time_to_first_token.or(first_token);
                attempt.finish_reason = Some(response.finish_reason.clone());
                if received_response {
                    record.usage.accumulate(response.usage);
                } else {
                    record.usage = response.usage;
                    received_response = true;
                }
            }
            let result = result.and_then(|response| {
                if response
                    .tool_calls
                    .iter()
                    .any(|c| serde_json::from_str::<Value>(&c.arguments).is_err())
                {
                    Err(ModelError::InvalidToolCall {
                        message: "tool arguments are not JSON".into(),
                    })
                } else {
                    Ok(response)
                }
            });
            match result {
                Ok(response) => {
                    first_model_index = index;
                    telemetry::attempt_finished(&span, &attempt);
                    record.attempts.push(attempt);
                    answer = Some((response, emitted, held));
                    break;
                }
                Err(error) => {
                    all_timeouts &= matches!(error, ModelError::Timeout);
                    attempt.http_status = error.http_status().or(attempt.http_status);
                    tracing::warn!(
                        model = %id,
                        error_kind = telemetry::error_info(&error).0,
                        http_status = attempt.http_status,
                        "assistant model attempt failed"
                    );
                    attempt.error = Some(error.clone());
                    telemetry::attempt_finished(&span, &attempt);
                    record.attempts.push(attempt);
                    if record.grounding_retry && buffering {
                        tracing::warn!(
                            model = %id,
                            reason = "retry_failed",
                            "assistant grounding retry failed"
                        );
                        let fallback = guard_text(&record, ctx.language);
                        text(&mut record, tx, fallback.into());
                        return record;
                    }
                    if !buffering && !held.is_empty() {
                        text(&mut record, tx, std::mem::take(&mut held));
                    }
                    if matches!(error, ModelError::DailyQuota { .. }) {
                        quota::mark_openrouter_exhausted(state).await;
                        telemetry::quota_hit(
                            state,
                            &ctx.actor,
                            &record.trace_id,
                            ctx.thread_id,
                            record.eval.as_ref(),
                            "openrouter",
                        );
                        record.error = Some("quota");
                        text(&mut record, tx, error_text("quota", ctx.language).into());
                        return record;
                    }
                    if emitted || !error.retryable() {
                        record.error = Some("model_unavailable");
                        return record;
                    }
                }
            }
        }
        let Some((mut response, emitted, mut held)) = answer else {
            // Six tool turns terminate gracefully; an exhausted fallback list is a model error.
            record.error = Some(if all_timeouts {
                "timeout"
            } else {
                "model_unavailable"
            });
            return record;
        };
        record.model = Some(response.model.clone());
        if response.tool_calls.is_empty() {
            let registry = &state.assistant.registry;
            if let Some(calls) = parse_text_tool_calls(
                &response.content,
                &|name| registry.get(name).is_some(),
                record.tools.len(),
            ) {
                response.tool_calls = calls;
                response.content.clear();
                held.clear();
            }
        }
        if buffering && response.tool_calls.is_empty() {
            let answer = if held.is_empty() {
                response.content.clone()
            } else {
                held
            };
            let unmatched = unmatched_numbers(&record, &answer);
            if !unmatched.is_empty() {
                if record.eval.is_some() {
                    tracing::warn!(unmatched_numbers = ?unmatched, "assistant eval grounding mismatch");
                }
                tracing::warn!(
                    model = %response.model,
                    reason = if record.grounding_retry {
                        "still_ungrounded"
                    } else {
                        "ungrounded_numbers"
                    },
                    "assistant grounding guard fired"
                );
                if record.grounding_retry || record.attempts.len() >= max_calls {
                    let fallback = guard_text(&record, ctx.language);
                    text(&mut record, tx, fallback.into());
                    return record;
                }
                // Drop the answer and ask once more; tool_choice stays auto.
                record.grounding_retry = true;
                // The model needs the rejected draft and the mismatches to repair it.
                // Neither becomes evidence: only user input and tools enter the guard.
                messages.push(ChatMessage::assistant(Some(answer), vec![]));
                messages.push(ChatMessage::system(format!("Các số chưa khớp: {unmatched:?}. Đây là bản nháp bị từ chối, chưa gửi cho người dùng, không phải dữ liệu. Viết lại toàn bộ câu trả lời cuối để trả lời câu hỏi ban đầu; không nói câu trên đã đúng hay giải thích việc sửa bản nháp. {}", if record.tools.iter().any(|t| t.ok) {
                    "Có số liệu chưa khớp. Dùng lại kết quả công cụ trong lượt này, viết đúng số và đơn vị; chỉ gọi thêm công cụ nếu thiếu dữ liệu. Không lặp lại công cụ đã có dữ liệu."
                } else {
                    "Hãy gọi công cụ để lấy số liệu trước khi trả lời."
                })));
                continue;
            }
            if !answer.is_empty() {
                record
                    .transcript
                    .push(ChatMessage::assistant(Some(answer.clone()), vec![]));
                text(&mut record, tx, answer);
                return record;
            }
        } else if !held.is_empty() {
            // A tool-call preamble is also model text; do not leak invented figures.
            if !has_ungrounded_number(&record, &held) {
                text(&mut record, tx, held);
            }
        }
        let message =
            ChatMessage::assistant(Some(response.content.clone()), response.tool_calls.clone());
        record.transcript.push(message.clone());
        messages.push(message);
        if response.tool_calls.is_empty() {
            // Providers normally send deltas. Preserve a valid non-streaming reply too.
            if !emitted && !response.content.is_empty() {
                text(&mut record, tx, response.content.clone());
            }
            if !response.content.is_empty() || emitted {
                return record;
            }
        } else {
            let results = join_all(
                response
                    .tool_calls
                    .iter()
                    .enumerate()
                    .map(|(index, call)| run_tool(ctx, call, tx, index >= MAX_TOOL_CALLS)),
            )
            .await;
            for (message, tool, summary, card) in results {
                record.transcript.push(message.clone());
                messages.push(message);
                record.tools.push(tool);
                record.tool_calls.push(summary);
                if let Some(card) = card {
                    record.cards.push(card);
                }
            }
        }
    }
    text(
        &mut record,
        tx,
        if ctx.language == Language::Vi {
            "Xin lỗi, mình chưa thể hoàn tất yêu cầu. Bạn thử hỏi ngắn gọn hơn nhé."
        } else {
            "Sorry, I could not finish this request. Please try a shorter question."
        }
        .into(),
    );
    record
}

async fn run_tool(
    ctx: &ToolContext,
    call: &ToolCall,
    tx: &Sender,
    over_limit: bool,
) -> (ChatMessage, ToolRecord, ToolSummary, Option<Value>) {
    let kind = ctx
        .state
        .assistant
        .registry
        .get(&call.name)
        .map(|t| t.kind());
    let span = telemetry::tool_span(&call.name, &call.id, kind);
    run_tool_inner(ctx, call, tx, over_limit)
        .instrument(span)
        .await
}
async fn run_tool_inner(
    ctx: &ToolContext,
    call: &ToolCall,
    tx: &Sender,
    over_limit: bool,
) -> (ChatMessage, ToolRecord, ToolSummary, Option<Value>) {
    let registry = &ctx.state.assistant.registry;
    let tool = registry.get(&call.name);
    stream::send(
        tx,
        StreamEvent::ToolStarted {
            call_id: call.id.clone(),
            tool: call.name.clone(),
            label_vi: tool.as_ref().map_or("Đang xử lý…", |t| t.label_vi()).into(),
        },
    );
    let args: Value = serde_json::from_str(&call.arguments).unwrap_or(Value::Null);
    let started = Instant::now();
    // Calls past the cap are answered with an error so the transcript stays paired.
    let result = if over_limit {
        None
    } else {
        Some(
            tokio::time::timeout(
                ctx.state.assistant.config.tool_timeout,
                registry.run(ctx, &call.name, args.clone()),
            )
            .await,
        )
    };
    let mut denied = false;
    let (ok, data, summary_vi, rows, card) = match result {
        Some(Ok(Ok(output))) => {
            if let Some(action) = output.action {
                stream::send(tx, StreamEvent::Action(action));
            }
            if let Some(card) = &output.card {
                stream::send(tx, StreamEvent::Card(card.clone()));
            }
            (
                true,
                output.data,
                output.summary_vi,
                output.rows,
                output.card,
            )
        }
        error => {
            let (code, message) = match error {
                None => (
                    "too_many_tool_calls",
                    "Quá nhiều lệnh công cụ trong một lượt.",
                ),
                Some(Err(_)) => ("timeout", "Công cụ phản hồi quá lâu. Bạn thử lại sau nhé."),
                Some(Ok(Err(ToolError::Denied))) => {
                    denied = true;
                    ("denied", "Bạn không có quyền dùng công cụ này.")
                }
                Some(Ok(Err(ToolError::InvalidArguments(_)))) => {
                    ("invalid_arguments", "Tham số công cụ không hợp lệ.")
                }
                Some(Ok(Err(ToolError::NotFound(_)))) => {
                    ("not_found", "Không tìm thấy công cụ hoặc dữ liệu.")
                }
                _ => ("failed", "Không thể đọc dữ liệu lúc này."),
            };
            (
                false,
                json!({"error":code,"message":message}),
                message.into(),
                0,
                None,
            )
        }
    };
    stream::send(
        tx,
        StreamEvent::ToolFinished {
            call_id: call.id.clone(),
            tool: call.name.clone(),
            ok,
            summary_vi: summary_vi.clone(),
        },
    );
    let span = tracing::Span::current();
    span.record("taphoa.tool.ok", ok);
    span.record("taphoa.tool.rows", rows as i64);
    span.record("taphoa.tool.denied", denied);
    let empty = ok && data_is_empty(&data);
    let record = ToolRecord {
        span_id: telemetry::span_id(&span).unwrap_or_else(|| Uuid::new_v4().simple().to_string()),
        name: call.name.clone(),
        call_id: call.id.clone(),
        kind: tool.map(|t| t.kind()),
        args,
        ok,
        denied,
        rows,
        empty,
        latency: started.elapsed(),
        summary_vi: summary_vi.clone(),
    };
    (
        ChatMessage::tool(&call.id, data.to_string()),
        record,
        ToolSummary {
            call_id: call.id.clone(),
            tool: call.name.clone(),
            ok,
            summary_vi,
        },
        card,
    )
}
/// Minimal write used when `persist` fails or the turn task panics.
async fn mark_failed(state: &AppState, message_id: Uuid) {
    let Ok(db) = pool(state) else { return };
    let _ = sqlx::query(
        "UPDATE assistant_messages SET status='failed' WHERE id=$1 AND status='streaming'",
    )
    .bind(message_id)
    .execute(db)
    .await;
}
async fn persist(state: &AppState, record: &TurnRecord) -> ApiResult<()> {
    let mut tx = pool(state)?.begin().await?;
    sqlx::query("UPDATE assistant_messages SET content=$2,tool_calls=$3,transcript=$4,cards=$5,model=$6,input_tokens=$7,output_tokens=$8,trace_id=$9,status=$10,span_id=COALESCE(span_id,$11) WHERE id=$1")
        .bind(record.message_id).bind(&record.content).bind(json!(record.tool_calls)).bind(json!(record.transcript)).bind(json!(record.cards)).bind(&record.model)
        .bind(i32::try_from(record.usage.input_tokens).unwrap_or(i32::MAX)).bind(i32::try_from(record.usage.output_tokens).unwrap_or(i32::MAX)).bind(&record.trace_id)
        .bind(if record.error.is_some() {"failed"} else {"complete"}).bind(&record.span_id).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE assistant_threads SET updated_at=now(),title=COALESCE(title,(SELECT left(content,60) FROM assistant_messages WHERE thread_id=$1 AND role='user' ORDER BY created_at,id LIMIT 1)) WHERE id=$1",
    )
    .bind(record.thread_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn actor() -> Actor {
        Actor {
            store_id: Uuid::new_v4(),
            member_id: Uuid::new_v4(),
            clerk_user_id: "user_test".into(),
            clerk_session_id: "sess_test".into(),
            role: Role::Lead,
            can_enroll: true,
        }
    }
    #[test]
    fn prompts_render_date_role_language_context_and_version() {
        for (language, weekday, role) in [
            (Language::Vi, "Thứ Ba", "Chủ cửa hàng"),
            (Language::En, "Tuesday", "Store owner"),
        ] {
            let prompt = render_prompt(
                "Cửa hàng {role}",
                Role::Lead,
                NaiveDate::from_ymd_opt(2026, 2, 17).unwrap(),
                language,
                Some(&json!({"screen":"camera","receipt_id":Uuid::nil(),"image_id":Uuid::nil()})),
            );
            assert!(prompt.starts_with(&format!("<!-- prompt-version: {PROMPT_VERSION} -->")));
            assert!(prompt.contains(&format!("[đính kèm ảnh {}] (image_id)", Uuid::nil())));
            assert!(prompt.contains(&format!("[đính kèm hóa đơn {}] (receipt_id)", Uuid::nil())));
            let rules = if language == Language::Vi {
                [
                    "Luôn gọi công cụ để lấy số liệu trước khi trả lời câu hỏi về cửa hàng; không trả lời số liệu từ trí nhớ.",
                    "Tuần bắt đầu từ thứ Hai.",
                    "Nếu công cụ báo không có quyền, nói lịch sự rằng vai trò của bạn không xem được dữ liệu đó.",
                ]
            } else {
                [
                    "Always call tools to retrieve figures before answering questions about the store; never answer figures from memory.",
                    "Weeks start on Monday.",
                    "If a tool reports permission denied, politely explain that your role cannot view those data.",
                ]
            };
            for rule in rules {
                assert!(prompt.contains(rule), "{rule}: {prompt}");
            }

            for text in [
                "2026-02-17",
                weekday,
                role,
                "camera",
                language.as_str(),
                "receipt_id",
                "Cửa hàng {role}",
                "propose_*",
            ] {
                assert!(prompt.contains(text), "{text}: {prompt}");
            }
        }
    }
    #[test]
    fn routing_guidance_and_relative_dates_are_explicit() {
        for language in [Language::Vi, Language::En] {
            let prompt = render_prompt(
                "Cửa hàng",
                Role::Lead,
                NaiveDate::from_ymd_opt(2026, 10, 20).unwrap(),
                language,
                None,
            );
            for tool in [
                "get_recognition_health",
                "get_member_activity",
                "get_sales_summary",
                "get_restock_plan",
            ] {
                assert!(prompt.contains(tool), "{tool}");
            }
            assert!(prompt.contains("yesterday): 2026-10-19"));
            assert!(prompt.contains(if language == Language::Vi {
                "Không trả lời nội dung ngoài phạm vi"
            } else {
                "Do not answer the unrelated question"
            }));
        }
    }
    fn tool_record(kind: ToolKind, ok: bool, data: &Value) -> ToolRecord {
        ToolRecord {
            span_id: String::new(),
            name: "t".into(),
            call_id: "c".into(),
            kind: Some(kind),
            args: Value::Null,
            ok,
            denied: false,
            rows: 0,
            empty: ok && data_is_empty(data),
            latency: Duration::ZERO,
            summary_vi: String::new(),
        }
    }
    #[test]
    fn data_without_rows_or_nonzero_figures_is_empty() {
        assert!(data_is_empty(&json!({"items":[]})));
        assert!(data_is_empty(
            &json!({"from":"2026-10-26","totals":{"revenue_dong":0,"sale_count":0},"groups":[]})
        ));
        assert!(!data_is_empty(
            &json!({"items":[{"name":"Mì","price_dong":7000}]})
        ));
        assert!(!data_is_empty(&json!({"totals":{"revenue_dong":15000}})));
    }
    #[test]
    fn a_dropped_answer_after_empty_reads_says_there_is_no_data() {
        let mut r = record_with("Giá món X?", vec![]);
        r.tools = vec![tool_record(ToolKind::Read, true, &json!({"items":[]}))];
        assert_eq!(guard_text(&r, Language::Vi), no_data_text(Language::Vi));
        assert_eq!(guard_text(&r, Language::En), no_data_text(Language::En));
        assert!(!no_data_text(Language::Vi).contains("thử hỏi lại"));
    }
    #[test]
    fn a_dropped_answer_keeps_the_retry_text_for_real_failures_and_real_data() {
        let none = record_with("Doanh thu?", vec![]);
        assert_eq!(
            guard_text(&none, Language::Vi),
            ungrounded_text(Language::Vi)
        );
        let mut failed = record_with("Doanh thu?", vec![]);
        failed.tools = vec![tool_record(ToolKind::Read, false, &Value::Null)];
        assert_eq!(
            guard_text(&failed, Language::Vi),
            ungrounded_text(Language::Vi)
        );
        let mut found = record_with("Doanh thu?", vec![]);
        found.tools = vec![
            tool_record(ToolKind::Read, true, &json!({"items":[]})),
            tool_record(
                ToolKind::Read,
                true,
                &json!({"totals":{"revenue_dong":15000}}),
            ),
        ];
        assert_eq!(
            guard_text(&found, Language::Vi),
            ungrounded_text(Language::Vi)
        );
        let mut propose = record_with("Đổi giá", vec![]);
        propose.tools = vec![tool_record(ToolKind::Propose, true, &json!({}))];
        assert_eq!(
            guard_text(&propose, Language::Vi),
            ungrounded_text(Language::Vi)
        );
    }
    #[test]
    fn invented_read_arguments_do_not_validate_the_reply() {
        let r = record_with(
            "Doanh thu?",
            vec![ChatMessage::assistant(
                None,
                vec![ToolCall {
                    id: "c1".into(),
                    name: "get_sales_summary".into(),
                    arguments: r#"{"revenue_dong":99999}"#.into(),
                }],
            )],
        );
        assert!(has_ungrounded_number(&r, "99.999 ₫"));
    }
    #[test]
    fn numbers_normalize_money_formats() {
        for text in [
            "150.000 ₫",
            "150000",
            "150k",
            "150 nghìn",
            "150,000 đồng",
            "0,15 triệu",
            "0.15tr",
            "150 ngàn",
        ] {
            assert_eq!(numbers(text, false), [150_000], "{text}");
        }
        assert_eq!(numbers("1,5 triệu và 2 tr", true), [1_500_000, 2_000_000]);
        assert_eq!(numbers("Ngày 26/10/2026 bán 7 đơn", true), [7]);
        assert!(numbers("Ngày 26/10/2026", false).is_empty());
        assert_eq!(numbers("1.234.000 ₫", true), [1_234_000]);
    }
    fn record_with(input: &str, transcript: Vec<ChatMessage>) -> TurnRecord {
        TurnRecord {
            span_id: None,
            input: input.into(),
            context: None,
            latency: Duration::ZERO,
            actor: actor(),
            today: NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(),
            language: Language::Vi,
            prompt_version: PROMPT_VERSION,
            thread_id: Uuid::new_v4(),
            message_id: Uuid::new_v4(),
            trace_id: String::new(),
            eval: None,
            attempts: vec![],
            tools: vec![],
            content: String::new(),
            transcript,
            tool_calls: vec![],
            cards: vec![],
            model: None,
            usage: Usage::default(),
            error: None,
            grounding_retry: false,
        }
    }
    #[test]
    fn grounding_is_per_number() {
        let propose = vec![
            ChatMessage::assistant(
                None,
                vec![ToolCall {
                    id: "c1".into(),
                    name: "propose_expense".into(),
                    arguments: r#"{"amount":150000,"note":"tiền điện"}"#.into(),
                }],
            ),
            ChatMessage::tool("c1", r#"{"data":{"status":"proposed"},"summary_vi":"ok"}"#),
        ];
        let r = record_with("Hãy đề xuất chi phí tiền điện 150000 đồng", propose);
        assert!(!has_ungrounded_number(&r, "Đã đề xuất 150.000 ₫"));
        assert!(has_ungrounded_number(&r, "Đã đề xuất 200.000 ₫"));
        let none = record_with("Hôm nay cửa hàng bán được bao nhiêu tiền?", vec![]);
        assert!(has_ungrounded_number(&none, "Hôm nay bán 0 ₫ (0 đơn)"));
        assert!(!has_ungrounded_number(&none, "Xin chào, 26/10/2026"));
        let read = record_with(
            "doanh thu?",
            vec![ChatMessage::tool(
                "c1",
                r#"{"data":{"total":1234000,"orders":"7"},"summary_vi":"x"}"#,
            )],
        );
        assert!(!has_ungrounded_number(
            &read,
            "Doanh thu 1.234.000 ₫ từ 7 đơn"
        ));
        let user = record_with("Tôi có 42 chai nước", vec![]);
        assert!(!has_ungrounded_number(&user, "Bạn có 42 chai nước"));
    }
    #[test]
    fn text_form_tool_calls_become_tool_calls() {
        let known = |n: &str| n == "get_sales_summary";
        let calls = parse_text_tool_calls(
            r#"[[{"name":"get_sales_summary","parameters":{}}]]"#,
            &known,
            0,
        )
        .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "text_call_1");
        assert_eq!(calls[0].name, "get_sales_summary");
        assert_eq!(calls[0].arguments, "{}");
        let calls = parse_text_tool_calls(
            r#" {"name":"get_sales_summary","arguments":{"day":"today"}} "#,
            &known,
            2,
        )
        .unwrap();
        assert_eq!(calls[0].id, "text_call_3");
        assert_eq!(calls[0].arguments, r#"{"day":"today"}"#);
        for no in [
            "",
            "Xin chào",
            r#"[{"name":"unknown","parameters":{}}]"#,
            r#"[{"name":"get_sales_summary"}]"#,
            r#"[{"name":"get_sales_summary","parameters":{}}, 3]"#,
            "[1, 2",
        ] {
            assert!(parse_text_tool_calls(no, &known, 0).is_none(), "{no}");
        }
    }
    #[test]
    fn store_numbers_are_detected_and_plain_text_is_not() {
        for yes in [
            "Hôm nay bán 0 ₫ (0 đơn)",
            "Bạn có 3 chai nước",
            "Doanh thu 1.234.000 ₫",
            "Còn 12 sản phẩm",
            "5 VND",
            "Tồn kho 42",
            "2 lon bia",
            "Ngày 26/10/2026 bán 7 đơn",
            "5 đồng",
            "Có 4 gói",
            "Sold 0 ₫",
        ] {
            assert!(contains_store_numbers(yes), "{yes}");
        }
        for no in [
            "",
            "Xin chào! Mình giúp được gì cho cửa hàng?",
            "Ngày 26/10/2026",
            "Từ 1-9-2026 đến 30/10/2026",
            "Làm theo 3 bước sau",
            "Chọn 1 để xem, 2 để sửa",
            "Hello, how can I help?",
        ] {
            assert!(!contains_store_numbers(no), "{no}");
        }
    }
    #[test]
    fn previous_turn_tool_results_are_labelled_and_other_messages_untouched() {
        assert_eq!(
            mark_previous_turn(ChatMessage::tool("c", r#"{"total":0}"#)),
            ChatMessage::tool("c", r#"{"from_previous_turn":true,"data":{"total":0}}"#)
        );
        let raw = ChatMessage::tool("c", "not json");
        let wrapped: Value =
            serde_json::from_str(mark_previous_turn(raw).content.as_deref().unwrap()).unwrap();
        assert_eq!(
            wrapped,
            json!({"from_previous_turn":true,"data":"not json"})
        );
        let user = ChatMessage::user("hi");
        assert_eq!(mark_previous_turn(user.clone()), user);
    }
    #[test]
    fn trimming_omits_oldest_tool_results_and_preserves_roles_and_ids() {
        let mut messages = vec![
            ChatMessage::system("rules"),
            ChatMessage::tool("old", "x".repeat(20000)),
            ChatMessage::tool("new", "y".repeat(10000)),
            ChatMessage::user("question"),
        ];
        trim_tool_results(&mut messages, false);
        assert_eq!(messages[1], ChatMessage::tool("old", r#"{"omitted":true}"#));
        assert_eq!(messages[2].content.as_ref().unwrap().len(), 10000);
        assert_eq!(messages[0], ChatMessage::system("rules"));
        trim_tool_results(&mut messages, true);
        assert_eq!(messages[2], ChatMessage::tool("new", r#"{"omitted":true}"#));
    }
    #[test]
    fn context_keeps_twenty_rows_replays_transcript_and_places_action_note_last() {
        let mut history: Vec<_> = (0..22)
            .map(|i| HistoryMessage {
                role: "user".into(),
                content: format!("question {i}"),
                attachments: json!([]),
                transcript: json!([]),
                created_at: Utc::now(),
            })
            .collect();
        history[3] = HistoryMessage {
            role: "assistant".into(),
            content: "reply".into(),
            attachments: json!([]),
            transcript: json!([
                ChatMessage::assistant(
                    None,
                    vec![ToolCall {
                        id: "c".into(),
                        name: "a".into(),
                        arguments: "{}".into()
                    }]
                ),
                ChatMessage::tool("c", r#"{"value":1}"#),
                ChatMessage::assistant(Some("reply".into()), vec![])
            ]),
            created_at: Utc::now(),
        };
        let messages = build_context(
            "Store",
            &actor(),
            NaiveDate::from_ymd_opt(2026, 2, 17).unwrap(),
            Language::Vi,
            None,
            history,
            vec![
                ("Chi thử".into(), "done".into()),
                ("Mời".into(), "rejected".into()),
            ],
        );
        assert_eq!(messages[1], ChatMessage::user("question 2"));
        assert!(
            !messages
                .iter()
                .any(|m| m.content.as_deref() == Some("question 1"))
        );
        assert_eq!(
            messages
                .iter()
                .filter(|m| m.content.as_deref() == Some("reply"))
                .count(),
            1
        );
        assert!(messages.iter().any(
            |m| m.role == ChatRole::Tool && m.content.as_deref() == Some(r#"{"omitted":true}"#)
        ));
        let last = messages.last().unwrap();
        assert_eq!(last.role, ChatRole::System);
        assert!(
            last.content
                .as_ref()
                .unwrap()
                .contains("Chi thử đã được xác nhận")
        );
        assert!(last.content.as_ref().unwrap().contains("Mời bị từ chối"));
    }
}
