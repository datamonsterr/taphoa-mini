//! Assistant spans and non-blocking PostHog captures. Content belongs only in masked events.
use super::{
    agent::{ModelAttempt, TurnRecord},
    model::{ChatRole, ModelError},
    threads::{ActionRow, Rating},
    tools::ToolKind,
};
use crate::{
    AppState,
    analytics::{CaptureEvent, EventContext, ProductEvent},
    auth::Actor,
};
use opentelemetry::trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState};
use serde_json::{Value, json};
use std::sync::OnceLock;
use tracing::{Span, instrument::WithSubscriber};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use uuid::Uuid;

pub fn distinct_id(actor: &Actor) -> String {
    actor.member_id.to_string()
}
pub(crate) fn event_context(actor: &Actor) -> EventContext {
    EventContext {
        distinct_id: distinct_id(actor),
        store_id: actor.store_id,
        member_id: actor.member_id,
        role: actor.role,
    }
}
pub(crate) fn environment() -> &'static str {
    static ENVIRONMENT: OnceLock<String> = OnceLock::new();
    ENVIRONMENT.get_or_init(|| crate::telemetry::TelemetryConfig::from_env().environment)
}
pub(crate) fn initialize() {
    let _ = environment();
}

pub(crate) fn invoke_span(thread: Uuid, context: Option<&Value>) -> Span {
    let screen = context.and_then(|c| c["screen"].as_str()).unwrap_or("chat");
    tracing::info_span!("assistant turn", otel.name = "invoke_agent taphoa-assistant", otel.kind = "internal",
        gen_ai.operation.name = "invoke_agent", gen_ai.agent.name = "taphoa-assistant", gen_ai.conversation.id = %thread,
        taphoa.assistant.use_cases = tracing::field::Empty, taphoa.assistant.screen = mask_text(screen),
        taphoa.store.id = tracing::field::Empty, taphoa.member.id = tracing::field::Empty,
        taphoa.member.role = tracing::field::Empty, session.id = tracing::field::Empty)
}
pub(crate) fn trace_id(span: &Span) -> String {
    let cx = span.context();
    let id = cx.span().span_context().trace_id();
    if id != TraceId::INVALID {
        id.to_string()
    } else {
        Uuid::new_v4().simple().to_string()
    }
}
pub(crate) fn span_id(span: &Span) -> Option<String> {
    let cx = span.context();
    let id = cx.span().span_context().span_id();
    (id != SpanId::INVALID).then(|| id.to_string())
}
pub(crate) fn chat_span(model: &str, index: usize, address: &str) -> Span {
    tracing::info_span!("assistant model", otel.name = format!("chat {model}"), otel.kind = "client",
        gen_ai.operation.name = "chat", gen_ai.provider.name = "openrouter", gen_ai.request.model = model,
        gen_ai.response.model = tracing::field::Empty, gen_ai.usage.input_tokens = tracing::field::Empty,
        gen_ai.usage.output_tokens = tracing::field::Empty, gen_ai.response.finish_reasons = tracing::field::Empty,
        taphoa.assistant.fallback_index = index as i64, taphoa.assistant.time_to_first_token_ms = tracing::field::Empty,
        server.address = address, error.type = tracing::field::Empty, otel.status_code = tracing::field::Empty)
}
pub(crate) fn attempt_finished(span: &Span, attempt: &ModelAttempt) {
    span.record("gen_ai.response.model", &attempt.model);
    span.record(
        "gen_ai.usage.input_tokens",
        i64::from(attempt.usage.input_tokens),
    );
    span.record(
        "gen_ai.usage.output_tokens",
        i64::from(attempt.usage.output_tokens),
    );
    if let Some(reason) = &attempt.finish_reason {
        span.set_attribute(
            "gen_ai.response.finish_reasons",
            opentelemetry::Value::Array(opentelemetry::Array::String(vec![reason.clone().into()])),
        );
    }
    if let Some(time) = attempt.time_to_first_token {
        span.record(
            "taphoa.assistant.time_to_first_token_ms",
            time.as_secs_f64() * 1000.0,
        );
    }
    if let Some(error) = &attempt.error {
        span.record("error.type", error_info(error).0);
        span.record("otel.status_code", "ERROR");
    }
}
pub(crate) fn tool_span(name: &str, call: &str, kind: Option<ToolKind>) -> Span {
    tracing::info_span!(
        "assistant tool",
        otel.name = format!("execute_tool {name}"),
        otel.kind = "internal",
        gen_ai.operation.name = "execute_tool",
        gen_ai.tool.name = name,
        gen_ai.tool.call.id = call,
        taphoa.tool.kind = tool_kind(kind),
        taphoa.tool.ok = tracing::field::Empty,
        taphoa.tool.rows = tracing::field::Empty,
        taphoa.tool.denied = tracing::field::Empty
    )
}
fn tool_kind(kind: Option<ToolKind>) -> &'static str {
    match kind {
        Some(ToolKind::Read) => "read",
        Some(ToolKind::Propose) => "propose",
        None => "unknown",
    }
}
pub(crate) fn action_span(row: &ActionRow) -> Span {
    let status = match row.status.as_str() {
        "done" => "confirmed",
        "rejected" => "rejected",
        "expired" => "expired",
        _ => "failed",
    };
    let span = tracing::info_span!("assistant action", otel.name = format!("assistant.action {}", row.kind), otel.kind = "internal",
        taphoa.action.id = %row.id, taphoa.action.kind = row.kind, taphoa.action.status = tracing::field::Empty);
    if row.status != "proposed" && row.status != "executing" {
        span.record("taphoa.action.status", status);
    }
    if let (Some(trace), Some(id)) = (&row.trace_id, &row.span_id)
        && let (Ok(trace), Ok(id)) = (TraceId::from_hex(trace), SpanId::from_hex(id))
    {
        let linked = SpanContext::new(trace, id, TraceFlags::SAMPLED, false, TraceState::default());
        if linked.is_valid() {
            span.add_link(linked);
        }
    }
    span
}

pub(crate) fn capture(state: &AppState, events: Vec<CaptureEvent>) {
    let analytics = state.analytics.clone();
    tokio::spawn(
        async move {
            for event in events {
                if analytics.capture_event(event).await.is_err() {
                    tracing::warn!("assistant analytics capture failed");
                }
            }
        }
        .with_current_subscriber(),
    );
}
pub(crate) fn event(actor: &Actor, name: &str, properties: Value) -> CaptureEvent {
    let mut properties = properties.as_object().cloned().unwrap_or_default();
    properties.insert("member_id".into(), json!(actor.member_id));
    properties.insert("role".into(), json!(actor.role));
    properties
        .entry("environment")
        .or_insert_with(|| json!(environment()));
    CaptureEvent {
        uuid: None,
        timestamp: None,
        distinct_id: distinct_id(actor),
        event: name.into(),
        properties,
        groups: serde_json::Map::from_iter([("store".into(), json!(actor.store_id))]),
    }
}
pub(crate) fn product(
    state: &AppState,
    actor: &Actor,
    product: &ProductEvent,
    trace: Option<&str>,
) {
    let mut event = CaptureEvent::product(&event_context(actor), product);
    event.properties.insert("$ai_trace_id".into(), json!(trace));
    event
        .properties
        .insert("environment".into(), json!(environment()));
    capture(state, vec![event]);
}
fn turn_event(record: &TurnRecord, name: &str, properties: Value) -> CaptureEvent {
    let mut event = event(&record.actor, name, properties);
    event
        .properties
        .insert("$ai_trace_id".into(), json!(record.trace_id));
    event
        .properties
        .insert("$ai_session_id".into(), json!(record.thread_id));
    if let Some(eval) = &record.eval {
        event.properties.insert("environment".into(), json!("eval"));
        event
            .properties
            .insert("eval_run_id".into(), json!(eval.run_id));
    }
    event
}
pub(crate) fn turn_finished(state: &AppState, record: &TurnRecord) {
    let record = record.clone();
    let state = state.clone();
    tokio::spawn(async move {
        let context = record.context.as_ref();
        let next = context.and_then(|c| c["next_step_id"].as_str());
        let entry = if next.is_some() { "chip" } else if context.is_some_and(|c| !c["receipt_id"].is_null()) { "receipt" } else { "button" };
        let use_cases = use_cases(record.tools.iter().map(|t| t.name.as_str()));
        let masker = Masker::for_record(&record);
        let mut events = vec![turn_event(&record,"$ai_trace",json!({
            "$ai_span_name":"assistant.turn", "$ai_input_state":masker.text(&record.input), "$ai_output_state":masker.text(&record.content),
            "$ai_latency":record.latency.as_secs_f64(), "$ai_is_error":record.error.is_some(), "$ai_error":record.error,
            "use_cases":use_cases, "entry":entry, "next_step_kind":next.map(|s|s.split(':').next().unwrap_or(s)), "prompt_version":record.prompt_version
        }))];
        for attempt in &record.attempts {
            let input: Vec<_> = attempt.request.messages.iter().map(|m|json!({"role":m.role,"content":m.content.as_deref().map(|text| masker.content(text, m.role))})).collect();
            let mut properties = json!({
                "$ai_span_id":attempt.span_id, "$ai_parent_id":record.trace_id,
                "$ai_model":attempt.model, "$ai_provider":"openrouter", "$ai_input":json!(input),
                "$ai_output_choices":masker.json(json!([{"role":"assistant","content":attempt.content}])),
                "$ai_input_tokens":attempt.usage.input_tokens, "$ai_output_tokens":attempt.usage.output_tokens,
                "$ai_latency":attempt.latency.as_secs_f64(), "$ai_time_to_first_token":attempt.time_to_first_token.map(|t|t.as_secs_f64()),
                "time_to_first_token_ms":attempt.time_to_first_token.map(|t|t.as_secs_f64()*1000.0), "$ai_http_status":attempt.http_status,
                "$ai_is_error":attempt.error.is_some(), "$ai_error":attempt.error.as_ref().map(|e| {let (kind,message)=error_info(e); json!({"kind":kind,"message":message})}),
                "$ai_stop_reason":attempt.finish_reason, "$ai_tools":attempt.request.tools.iter().map(|t|masker.text(&t.name)).collect::<Vec<_>>(),
                "$ai_stream":true, "fallback_index":attempt.fallback_index
            });
            generation_costs(&mut properties, &attempt.request.model, attempt.usage.cost);
            events.push(turn_event(&record,"$ai_generation",properties));
        }
        for tool in &record.tools {
            events.push(turn_event(&record,"$ai_span",json!({
                "$ai_span_id":tool.span_id, "$ai_parent_id":record.trace_id, "$ai_span_name":format!("tool:{}",tool.name),
                "$ai_input_state":masker.tool_args(&tool.name, tool.args.clone()), "$ai_output_state":masker.json(json!({"summary_vi":tool.summary_vi,"rows":tool.rows,"ok":tool.ok})),
                "$ai_latency":tool.latency.as_secs_f64(), "$ai_is_error":!tool.ok, "$ai_error":if tool.ok {None} else {Some(if tool.denied {"denied"} else {"tool_failed"})},
                "tool_kind":tool_kind(tool.kind), "denied":tool.denied
            })));
        }
        for event in events { if state.analytics.capture_event(event).await.is_err() { tracing::warn!("assistant analytics capture failed"); } }
    }.with_current_subscriber());
}
fn generation_costs(properties: &mut Value, model: &str, cost: Option<super::model::UsageCost>) {
    if model.ends_with(":free") {
        for key in [
            "$ai_input_cost_usd",
            "$ai_output_cost_usd",
            "$ai_total_cost_usd",
        ] {
            properties[key] = json!(0);
        }
    } else if let Some(cost) = cost {
        properties["$ai_total_cost_usd"] = json!(cost.total_usd);
        if let Some(input) = cost.input_usd {
            properties["$ai_input_cost_usd"] = json!(input);
        }
        if let Some(output) = cost.output_usd {
            properties["$ai_output_cost_usd"] = json!(output);
        }
        properties["cost_source"] = json!("openrouter_usage");
    }
}

pub(crate) fn quota_hit(
    state: &AppState,
    actor: &Actor,
    trace: &str,
    thread: Uuid,
    eval: Option<&super::eval::EvalContext>,
    scope: &str,
) {
    let mut event = event(
        actor,
        "assistant_quota_hit",
        json!({"$ai_trace_id":trace,"$ai_session_id":thread,"scope":scope}),
    );
    if let Some(eval) = eval {
        event.properties.insert("environment".into(), json!("eval"));
        event
            .properties
            .insert("eval_run_id".into(), json!(eval.run_id));
    }
    capture(state, vec![event]);
}
pub(crate) fn feedback(
    state: &AppState,
    actor: &Actor,
    message: Uuid,
    trace: Option<&str>,
    rating: Rating,
    comment: Option<&str>,
) {
    let comment = comment.map(mask_text);
    let mut events = vec![event(
        actor,
        "assistant_feedback_submitted",
        json!({"$ai_trace_id":trace,"message_id":message,"rating":rating.as_str(),"comment":comment}),
    )];
    let config = &state.assistant.config;
    if let (Some(survey), Some(question)) =
        (&config.feedback_survey_id, &config.feedback_question_id)
    {
        let mut properties = json!({"$survey_id":survey,"$ai_trace_id":trace,"$survey_submission_id":Uuid::new_v4(),"$survey_completed":true});
        properties[format!("$survey_response_{question}")] =
            json!(if rating == Rating::Up { 1 } else { 2 });
        if let (Some(question), Some(comment)) = (&config.feedback_comment_question_id, comment) {
            properties[format!("$survey_response_{question}")] = json!(comment);
        }
        events.push(event(actor, "survey sent", properties));
    }
    capture(state, events);
}
// Provider messages may echo credentials, request bodies or URLs. Export only safe local wording.
pub(crate) fn error_info(error: &ModelError) -> (&'static str, &'static str) {
    match error {
        ModelError::RateLimited { .. } => ("rate_limited", "model rate limited"),
        ModelError::DailyQuota { .. } => ("daily_quota", "free model daily quota exhausted"),
        ModelError::Unavailable { .. } => ("unavailable", "model unavailable"),
        ModelError::Timeout => ("timeout", "model request timed out"),
        ModelError::InvalidToolCall { .. } => {
            ("invalid_tool_call", "tool arguments are not valid JSON")
        }
        ModelError::StreamFailed { .. } => ("stream_failed", "model stream failed"),
        ModelError::Other { .. } => ("model_error", "model call failed"),
    }
}
pub(crate) fn use_cases<'a>(tools: impl Iterator<Item = &'a str>) -> Vec<&'static str> {
    let mut cases = Vec::new();
    for tool in tools {
        let ids: &[&str] = match tool {
            "get_restock_plan" => &["U1"],
            "propose_reorder_list" => &["U1", "U11"],
            "get_store_overview" | "get_sales_summary" | "get_top_products" => &["U2"],
            "get_margin_report" => &["U3"],
            "propose_price_change" => &["U3", "U11"],
            "get_dead_stock" => &["U4"],
            "explain_day_close" => &["U5"],
            "list_review_queue" | "suggest_manual_line_matches" => &["U6"],
            "get_recognition_health" => &["U7"],
            "get_member_activity" => &["U8"],
            "detect_anomalies" => &["U9"],
            "get_tax_overview" => &["U10"],
            "search_help" => &["U12"],
            "get_receipt" => &["U14"],
            "propose_receipt_line_update" | "propose_receipt_confirm" => &["U11", "U14"],
            "search_sales" | "search_products" | "list_expenses" | "get_stock_levels" => &["U16"],
            "get_supplier_prices" => &["U17"],
            "forecast_demand" => &["U18"],
            "get_catalog_issues" => &["U19"],
            "suggest_low_stock_thresholds" => &["U20"],
            "propose_threshold_update" => &["U11", "U20"],
            "get_setup_checklist" => &["U21"],
            "propose_invite" => &["U11", "U21"],
            "start_export" => &["U10", "U22"],
            "get_debts" | "draft_debt_reminder" => &["U23"],
            "propose_repayment" | "propose_debt_adjustment" => &["U11", "U23"],
            "propose_stock_adjustment" | "propose_expense" => &["U11"],
            _ => &[],
        };
        for id in ids {
            if !cases.contains(id) {
                cases.push(*id);
            }
        }
    }
    cases
}
// Tool messages contain serialized JSON. Redact string leaves without treating long
// decimal runs or integer measures as phone numbers and breaking that JSON.
#[cfg(test)]
fn mask_content(text: &str, role: ChatRole) -> String {
    Masker::default().content(text, role)
}
#[cfg(test)]
fn mask_json(value: Value) -> Value {
    Masker::default().json(value)
}
const HIDDEN: &str = "[đã ẩn]";
const NAME: &str = "[tên]";
/// JSON keys whose string value is personal data about a customer or member.
fn is_pii_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "phone"
            | "phone_number"
            | "email"
            | "customer_name"
            | "debtor_name"
            | "display_name"
            | "member_name"
            | "contact"
            | "address"
            | "note"
            | "notes"
    )
}
/// Keys that mark an object or list as describing people, so its plain `name` is personal too.
fn is_person_container(key: &str) -> bool {
    matches!(
        key,
        "customer" | "customers" | "debtor" | "member" | "members"
    )
}
fn has_person_field(object: &serde_json::Map<String, Value>) -> bool {
    ["customer_id", "phone", "customer_name", "debtor_name"]
        .iter()
        .any(|key| object.contains_key(*key))
}
/// Tools whose arguments name or search for a customer.
fn tool_args_are_personal(tool: &str) -> bool {
    tool.contains("debt") || tool.contains("repayment") || tool.contains("customer")
}
fn collect_pii(value: &Value, person: bool, out: &mut Vec<String>) {
    match value {
        Value::Array(values) => values.iter().for_each(|v| collect_pii(v, person, out)),
        Value::Object(object) => {
            let person = person || has_person_field(object);
            for (key, value) in object {
                match value {
                    Value::String(text)
                        if is_pii_key(key) || (person && key.eq_ignore_ascii_case("name")) =>
                    {
                        let text = text.trim();
                        // Phones and emails are caught by pattern, which keeps their own marker.
                        let pattern_masked = ["phone", "phone_number", "email"]
                            .iter()
                            .any(|k| key.eq_ignore_ascii_case(k));
                        if !pattern_masked && text.chars().count() >= 2 {
                            out.push(text.to_owned());
                        }
                    }
                    _ => collect_pii(value, person || is_person_container(key), out),
                }
            }
        }
        _ => {}
    }
}
/// Redacts what one assistant turn may not send to analytics: patterns (phones, emails, digit
/// runs), structured customer fields, and any customer or member value a tool returned in this
/// turn, wherever the model repeated it.
#[derive(Default)]
struct Masker {
    known: Vec<Vec<char>>,
}
impl Masker {
    fn for_record(record: &TurnRecord) -> Self {
        let mut found = Vec::new();
        for attempt in &record.attempts {
            for message in &attempt.request.messages {
                if message.role == ChatRole::Tool
                    && let Some(value) = message
                        .content
                        .as_deref()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                {
                    collect_pii(&value, false, &mut found);
                }
            }
        }
        for tool in &record.tools {
            if tool_args_are_personal(&tool.name) {
                collect_strings(&tool.args, &mut found);
            }
        }
        found.sort();
        found.dedup();
        // Longest first, so "Chị Lan" goes before "Lan".
        found.sort_by_key(|text| std::cmp::Reverse(text.chars().count()));
        Self {
            known: found.iter().map(|text| lower(text)).collect(),
        }
    }
    fn text(&self, text: &str) -> String {
        mask_text(&self.scrub(text))
    }
    fn content(&self, text: &str, role: ChatRole) -> String {
        if role != ChatRole::Tool {
            return self.text(text);
        }
        serde_json::from_str::<Value>(text)
            .map(|value| self.json(value).to_string())
            .unwrap_or_else(|_| self.text(text))
    }
    fn tool_args(&self, tool: &str, args: Value) -> Value {
        if tool_args_are_personal(tool) {
            hide_strings(args)
        } else {
            self.json(args)
        }
    }
    fn json(&self, value: Value) -> Value {
        self.json_in(value, false)
    }
    fn json_in(&self, value: Value, person: bool) -> Value {
        match value {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .map(|v| self.json_in(v, person))
                    .collect(),
            ),
            Value::Object(object) => {
                let person = person || has_person_field(&object);
                Value::Object(
                    object
                        .into_iter()
                        .map(|(key, value)| {
                            let hide = (is_pii_key(&key)
                                || (person && key.eq_ignore_ascii_case("name")))
                                && matches!(&value, Value::String(text) if !text.is_empty());
                            let value = if hide {
                                Value::String(HIDDEN.into())
                            } else {
                                self.json_in(value, person || is_person_container(&key))
                            };
                            (self.text(&key), value)
                        })
                        .collect(),
                )
            }
            value => value,
        }
    }
    /// Replaces each known customer or member value, case-insensitively, as a whole word.
    fn scrub(&self, text: &str) -> String {
        if self.known.is_empty() {
            return text.to_owned();
        }
        let chars: Vec<char> = text.chars().collect();
        let folded: Vec<char> = chars.iter().map(|c| fold(*c)).collect();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        'scan: while i < chars.len() {
            let boundary_before = i == 0 || !chars[i - 1].is_alphanumeric();
            if boundary_before {
                for needle in &self.known {
                    let end = i + needle.len();
                    if end <= chars.len()
                        && folded[i..end] == needle[..]
                        && (end == chars.len() || !chars[end].is_alphanumeric())
                    {
                        out.push_str(NAME);
                        i = end;
                        continue 'scan;
                    }
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }
}
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}
fn lower(text: &str) -> Vec<char> {
    text.chars().map(fold).collect()
}
fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if text.trim().chars().count() >= 2 => out.push(text.trim().to_owned()),
        Value::Array(values) => values.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(object) => object.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}
fn hide_strings(value: Value) -> Value {
    match value {
        Value::String(text) if !text.is_empty() => Value::String(HIDDEN.into()),
        Value::Array(values) => Value::Array(values.into_iter().map(hide_strings).collect()),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, hide_strings(value)))
                .collect(),
        ),
        value => value,
    }
}
/// Replaces `local@domain` addresses.
fn mask_emails(text: &str) -> String {
    if !text.contains('@') {
        return text.to_owned();
    }
    let chars: Vec<char> = text.chars().collect();
    let local = |c: char| c.is_alphanumeric() || "._%+-".contains(c);
    let domain = |c: char| c.is_alphanumeric() || ".-".contains(c);
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let mut right = i + 1;
            while right < chars.len() && domain(chars[right]) {
                right += 1;
            }
            // Drop a trailing sentence dot.
            while right > i + 1 && chars[right - 1] == '.' {
                right -= 1;
            }
            let host = &chars[i + 1..right];
            let mut left = out.len();
            while left > 0 && local(out[left - 1]) {
                left -= 1;
            }
            if left < out.len() && host.contains(&'.') && host[0] != '.' {
                out.truncate(left);
                out.extend("[email]".chars());
                i = right;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out.into_iter().collect()
}
/// A phone written with spaces, dots or dashes ("090 123 4567", "+84 90-123-4567"): starts with
/// `0` or `+` so lists of ordinary numbers and money like "1.234.000" are left alone.
/// Returns the byte length of the phone at the start of `rest`.
fn separated_phone(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let mut i = usize::from(bytes.first() == Some(&b'+'));
    if !bytes.get(i).is_some_and(u8::is_ascii_digit) || (i == 0 && bytes[0] != b'0') {
        return None;
    }
    let (mut digits, mut separators) = (0, 0);
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            digits += 1;
            i += 1;
        } else if matches!(bytes[i], b' ' | b'-' | b'.')
            && bytes.get(i + 1).is_some_and(u8::is_ascii_digit)
        {
            separators += 1;
            i += 1;
        } else {
            break;
        }
    }
    ((9..=15).contains(&digits) && separators > 0).then_some(i)
}
fn mask_text(text: &str) -> String {
    let text = &mask_emails(text);
    let mut result = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        // UUIDs are opaque identifiers, including UUIDs whose final group is all digits.
        if let Some(candidate) = rest.get(..36)
            && candidate.as_bytes().get(8) == Some(&b'-')
            && Uuid::parse_str(candidate).is_ok()
        {
            result.push_str(candidate);
            i += 36;
            continue;
        }
        let after_word = text[..i]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        if after_word && let Some(len) = separated_phone(rest) {
            result.push_str("[số]");
            i += len;
            continue;
        }
        let mut digits = 0;
        let mut end = 0;
        for digit in rest.chars().take_while(|c| c.is_numeric()) {
            digits += 1;
            end += digit.len_utf8();
        }
        if digits > 0 {
            result.push_str(if (9..=15).contains(&digits) {
                "[số]"
            } else {
                &rest[..end]
            });
            i += end;
        } else if let Some(c) = rest.chars().next() {
            result.push(c);
            i += c.len_utf8();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_costs_preserve_paid_accounting_and_explicit_free_zero() {
        let cost = super::super::model::UsageCost {
            input_usd: Some(0.01),
            output_usd: Some(0.02),
            total_usd: 0.03,
        };
        let mut properties = json!({});
        generation_costs(&mut properties, "x/paid", Some(cost));
        assert_eq!(properties["$ai_input_cost_usd"], 0.01);
        assert_eq!(properties["$ai_output_cost_usd"], 0.02);
        assert_eq!(properties["$ai_total_cost_usd"], 0.03);
        let mut missing = json!({});
        generation_costs(&mut missing, "x/paid", None);
        assert!(missing.get("$ai_total_cost_usd").is_none());
        generation_costs(&mut properties, "x/model:free", Some(cost));
        for key in [
            "$ai_input_cost_usd",
            "$ai_output_cost_usd",
            "$ai_total_cost_usd",
        ] {
            assert_eq!(properties[key], 0);
        }
    }

    #[test]
    fn masks_phones_and_banks_recursively_preserving_money_uuids_and_long_runs() {
        let input = json!({"nested":["0912345678",{"bank":"123456789012345","short":"12345678","money":"1.234.000","long":"1234567890123456","uuid":"12345678-1234-1234-1234-123456789012"}]});
        assert_eq!(
            mask_json(input),
            json!({"nested":["[số]",{"bank":"[số]","short":"12345678","money":"1.234.000","long":"1234567890123456","uuid":"12345678-1234-1234-1234-123456789012"}]})
        );
        assert_eq!(mask_text("SĐT 0912345678, 123456789!"), "SĐT [số], [số]!");
    }
    #[test]
    fn tool_json_preserves_numeric_evidence_while_masking_string_identifiers() {
        let raw = r#"{"change_pct":{"revenue":81.00948131622978},"annual_revenue_dong":121064500,"phone":"0912345678","nested":[{"quantity":3.1234567890123}]}"#;
        let masked: Value = serde_json::from_str(&mask_content(raw, ChatRole::Tool)).unwrap();
        assert_eq!(masked["change_pct"]["revenue"], json!(81.00948131622978));
        assert_eq!(masked["annual_revenue_dong"], json!(121064500));
        assert_eq!(masked["phone"], HIDDEN);
        assert_eq!(mask_content("123456789", ChatRole::User), "[số]");
        assert_eq!(mask_content("123456789", ChatRole::Assistant), "[số]");
        assert_eq!(masked["nested"][0]["quantity"], json!(3.1234567890123));
    }
    #[test]
    fn masks_unicode_digit_runs_and_preserves_longer_runs() {
        assert_eq!(mask_text("٠١٢٣٤٥٦٧٨٩ １２３４５６７８９０"), "[số] [số]");
        assert_eq!(mask_text("٠١٢٣٤٥٦٧٨٩٠١٢٣٤٥"), "٠١٢٣٤٥٦٧٨٩٠١٢٣٤٥");
    }
    #[test]
    fn masks_emails_and_separated_phones_but_not_money_or_number_lists() {
        assert_eq!(mask_text("gọi 090 123 4567 nhé"), "gọi [số] nhé");
        assert_eq!(mask_text("090-123-4567, 090.123.4567"), "[số], [số]");
        assert_eq!(mask_text("+84 90 123 4567"), "[số]");
        assert_eq!(mask_text("mail an@example.com."), "mail [email].");
        assert_eq!(mask_text("a@b"), "a@b");
        assert_eq!(
            mask_text("1.234.000 và 10 20 30 40 50 60"),
            "1.234.000 và 10 20 30 40 50 60"
        );
        assert_eq!(mask_text("12345678"), "12345678");
    }
    #[test]
    fn structured_customer_fields_and_names_seen_in_tools_are_hidden() {
        let tool = json!({"customers":[{"customer_id":"c1","name":"Chị Lan","phone":"0912345678","balance":50000}],"note":"x"});
        let masker = Masker {
            known: vec![lower("Chị Lan"), lower("Lan")],
        };
        let out = masker.json(tool);
        assert_eq!(out["customers"][0]["name"], HIDDEN);
        assert_eq!(out["customers"][0]["phone"], HIDDEN);
        assert_eq!(out["customers"][0]["balance"], 50000);
        assert_eq!(out["customers"][0]["customer_id"], "c1");
        // A product name is not personal data.
        let product = masker.json(json!({"products":[{"id":"p","name":"Coca"}]}));
        assert_eq!(product["products"][0]["name"], "Coca");
        // Names the model repeats, in any case, match whole words only.
        assert_eq!(
            masker.text("chị lan nợ 50.000; Lanh và balance không đổi"),
            "[tên] nợ 50.000; Lanh và balance không đổi"
        );
        assert_eq!(
            masker.tool_args("get_debts", json!({"search":"Lan","limit":5}))["search"],
            HIDDEN
        );
        assert_eq!(
            masker.tool_args("get_debts", json!({"search":"Lan","limit":5}))["limit"],
            5
        );
    }
}
