//! Voice spans and PostHog captures (docs/specs/assistant/telemetry-contract.md "Voice spans").
//! Neither the transcript nor the audio ever enters a span attribute or an `$ai_*` event.
use crate::{
    AppState,
    assistant::{
        model::ModelError,
        telemetry::{self as assistant, error_info},
    },
    auth::Actor,
};
use serde_json::json;
use std::time::Duration;
use tracing::Span;
use uuid::Uuid;

use super::model::ModelUsage;

/// One model call of an utterance, successful or not.
#[derive(Debug, Clone)]
pub struct CallRecord {
    /// `audio`, `stt` or `text`.
    pub kind: &'static str,
    pub model: String,
    pub response_model: Option<String>,
    pub fallback_index: usize,
    pub usage: ModelUsage,
    pub latency: Duration,
    pub http_status: Option<u16>,
    pub finish_reason: Option<String>,
    pub error: Option<ModelError>,
    pub span_id: Option<String>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Counts {
    pub lines: u32,
    pub matched: u32,
    pub ambiguous: u32,
    pub unknown: u32,
}

pub fn utterance_span(id: Uuid, mode: &str, entry: &str) -> Span {
    tracing::info_span!(
        "voice utterance",
        otel.name = "voice.utterance",
        otel.kind = "internal",
        voice.utterance.id = %id,
        voice.mode = mode,
        voice.entry = entry,
        voice.audio_seconds = tracing::field::Empty,
        voice.model = tracing::field::Empty,
        voice.stt_fallback = tracing::field::Empty,
        voice.intent = tracing::field::Empty,
        voice.lines = tracing::field::Empty,
        voice.matched = tracing::field::Empty,
        voice.ambiguous = tracing::field::Empty,
        voice.unknown = tracing::field::Empty,
        voice.latency_ms = tracing::field::Empty,
        taphoa.store.id = tracing::field::Empty,
        taphoa.member.id = tracing::field::Empty,
        taphoa.member.role = tracing::field::Empty,
        session.id = tracing::field::Empty,
        user.id = tracing::field::Empty,
        error.type = tracing::field::Empty,
        otel.status_code = tracing::field::Empty
    )
}

pub fn model_call_span(model: &str, kind: &'static str, index: usize, address: &str) -> Span {
    tracing::info_span!(
        "voice model call",
        otel.name = "voice.model_call",
        otel.kind = "client",
        gen_ai.operation.name = "chat",
        gen_ai.provider.name = "openrouter",
        gen_ai.request.model = model,
        gen_ai.response.model = tracing::field::Empty,
        gen_ai.usage.input_tokens = tracing::field::Empty,
        gen_ai.usage.output_tokens = tracing::field::Empty,
        gen_ai.response.finish_reasons = tracing::field::Empty,
        taphoa.assistant.fallback_index = index as i64,
        taphoa.voice.call = kind,
        server.address = address,
        error.type = tracing::field::Empty,
        otel.status_code = tracing::field::Empty
    )
}

pub fn call_finished(span: &Span, record: &CallRecord) {
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    if let Some(model) = &record.response_model {
        span.record("gen_ai.response.model", model.as_str());
    }
    span.record(
        "gen_ai.usage.input_tokens",
        i64::from(record.usage.input_tokens),
    );
    span.record(
        "gen_ai.usage.output_tokens",
        i64::from(record.usage.output_tokens),
    );
    if let Some(reason) = &record.finish_reason {
        span.set_attribute(
            "gen_ai.response.finish_reasons",
            opentelemetry::Value::Array(opentelemetry::Array::String(vec![reason.clone().into()])),
        );
    }
    if let Some(error) = &record.error {
        span.record("error.type", error_info(error).0);
        span.record("otel.status_code", "ERROR");
    }
}

pub fn utterance_finished(
    span: &Span,
    audio_seconds: Option<f64>,
    model: Option<&str>,
    stt_fallback: bool,
    intent: &str,
    counts: Counts,
    latency_ms: u64,
) {
    span.record("voice.audio_seconds", audio_seconds.unwrap_or(0.0));
    if let Some(model) = model {
        span.record("voice.model", model);
    }
    span.record("voice.stt_fallback", stt_fallback);
    span.record("voice.intent", intent);
    span.record("voice.lines", i64::from(counts.lines));
    span.record("voice.matched", i64::from(counts.matched));
    span.record("voice.ambiguous", i64::from(counts.ambiguous));
    span.record("voice.unknown", i64::from(counts.unknown));
    span.record("voice.latency_ms", latency_ms as i64);
}

pub fn failed(span: &Span, kind: &str) {
    span.record("error.type", kind);
    span.record("otel.status_code", "ERROR");
}

/// One `$ai_generation` per model call, cost from `usage.cost`; no audio, no transcript.
pub fn generations(
    state: &AppState,
    actor: &Actor,
    utterance: Uuid,
    trace: &str,
    calls: &[CallRecord],
) {
    let events = calls
        .iter()
        .map(|call| {
            let mut event = assistant::event(
                actor,
                "$ai_generation",
                json!({
                    "$ai_span_id": call.span_id,
                    "$ai_parent_id": trace,
                    "$ai_trace_id": trace,
                    "$ai_session_id": utterance,
                    "$ai_model": call.response_model.as_deref().unwrap_or(&call.model),
                    "$ai_provider": "openrouter",
                    "$ai_input_tokens": call.usage.input_tokens,
                    "$ai_output_tokens": call.usage.output_tokens,
                    "$ai_latency": call.latency.as_secs_f64(),
                    "$ai_http_status": call.http_status,
                    "$ai_is_error": call.error.is_some(),
                    "$ai_error": call.error.as_ref().map(|e| { let (kind, message) = error_info(e); json!({"kind": kind, "message": message}) }),
                    "$ai_stop_reason": call.finish_reason,
                    "$ai_stream": false,
                    "fallback_index": call.fallback_index,
                    "voice_call": call.kind,
                    "$ai_total_cost_usd": call.usage.cost_usd,
                }),
            );
            // The base event helper stamps member and role; the session is the utterance.
            event.properties.insert("$ai_session_id".into(), json!(utterance));
            event
        })
        .collect();
    assistant::capture(state, events);
}

pub fn drafted(
    state: &AppState,
    actor: &Actor,
    trace: &str,
    counts: Counts,
    latency_ms: u64,
    stt_fallback: bool,
) {
    assistant::product(
        state,
        actor,
        &crate::analytics::ProductEvent::VoiceSaleDrafted {
            lines: counts.lines,
            matched: counts.matched,
            ambiguous: counts.ambiguous,
            unknown: counts.unknown,
            latency_ms,
            stt_fallback,
        },
        Some(trace),
    );
}
