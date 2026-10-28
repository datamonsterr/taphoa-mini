//! One utterance: quota, catalog hint, model chain, rules and match, customer, stored row,
//! telemetry. The audio lives only in the request and is dropped with it.
use super::{
    VoiceState, draft,
    model::{AudioClip, Intent, Parsed, VoiceModel, VoiceParse},
    quota::{self, QuotaOutcome},
    telemetry::{self, CallRecord, Counts},
};
use crate::{
    ApiError, ApiResult, AppState,
    assistant::{Language, model::ModelError, telemetry as assistant},
    auth::Actor,
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::time::Instant;
use tracing::Instrument;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Sale,
    Transcribe,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sale => "sale",
            Self::Transcribe => "transcribe",
        }
    }
}

pub struct Request {
    pub id: Uuid,
    pub mode: Mode,
    pub language: Language,
    pub entry: String,
    pub clip: AudioClip,
    pub audio_seconds: Option<f64>,
    /// Eval runs pin the chain to one slug (`X-Taphoa-Eval-Model`, only when eval headers are on).
    pub model_override: Option<String>,
    /// Handler start, so `latency_ms` includes reading the upload.
    pub started: Instant,
}

pub fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "voice_unavailable",
        "voice understanding is unavailable",
    )
}
fn no_speech() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "no_speech",
        "nothing was heard",
    )
}
fn db(error: sqlx::Error) -> ApiError {
    crate::error::log_sqlx_error!(error, &error, "voice utterance query failed");
    ApiError::internal()
}

struct ChainOk {
    parsed: Parsed,
    stt_fallback: bool,
}

async fn attempt<T>(
    model: &dyn VoiceModel,
    slug: &str,
    // (call kind, fallback index, utterance deadline)
    site: (&'static str, usize, Instant),
    calls: &mut Vec<CallRecord>,
    run: impl std::future::Future<Output = Result<T, ModelError>>,
    describe: impl Fn(
        &T,
    ) -> (
        Option<String>,
        crate::voice::model::ModelUsage,
        Option<String>,
        Option<u16>,
    ),
) -> Result<T, ModelError> {
    let (kind, index, deadline) = site;
    let span = telemetry::model_call_span(slug, kind, index, model.server_address());
    let started = Instant::now();
    let result = match tokio::time::timeout_at(deadline.into(), run.instrument(span.clone())).await
    {
        Ok(result) => result,
        Err(_) => Err(ModelError::Timeout),
    };
    let latency = started.elapsed();
    let mut record = CallRecord {
        kind,
        model: slug.to_owned(),
        response_model: None,
        fallback_index: index,
        usage: Default::default(),
        latency,
        http_status: None,
        finish_reason: None,
        error: None,
        span_id: assistant::span_id(&span),
    };
    match &result {
        Ok(value) => {
            let (response_model, usage, finish, status) = describe(value);
            record.response_model = response_model;
            record.usage = usage;
            record.finish_reason = finish;
            record.http_status = status.or(Some(200));
        }
        Err(error) => {
            record.http_status = error.http_status();
            record.error = Some(error.clone());
        }
    }
    telemetry::call_finished(&span, &record);
    calls.push(record);
    result
}

fn describe_parsed(
    p: &Parsed,
) -> (
    Option<String>,
    super::model::ModelUsage,
    Option<String>,
    Option<u16>,
) {
    (
        Some(p.model.clone()),
        p.usage,
        p.finish_reason.clone(),
        Some(p.http_status),
    )
}

/// Audio-native model per slug, then STT plus a text parse (voice.md "Architecture").
async fn run_chain(
    voice: &VoiceState,
    model: &dyn VoiceModel,
    req: &Request,
    hint: &str,
    calls: &mut Vec<CallRecord>,
) -> Option<ChainOk> {
    let cfg = &voice.config;
    let deadline = req.started + cfg.total_timeout;
    let expired = || Instant::now() >= deadline;
    let models: Vec<String> = req
        .model_override
        .clone()
        .map_or_else(|| cfg.models.clone(), |m| vec![m]);
    for (index, slug) in models.iter().enumerate() {
        if expired() {
            return None;
        }
        let result = attempt(
            model,
            slug,
            ("audio", index, deadline),
            calls,
            model.parse_audio(slug, &req.clip, hint, req.language),
            describe_parsed,
        )
        .await;
        match result {
            Ok(parsed) => {
                return Some(ChainOk {
                    parsed,
                    stt_fallback: false,
                });
            }
            Err(error) => {
                tracing::warn!(model = %slug, error = %assistant::error_info(&error).0, "voice audio model failed")
            }
        }
    }
    let stt_index = models.len();
    if expired() {
        return None;
    }
    let transcript = attempt(
        model,
        &cfg.stt_model,
        ("stt", stt_index, deadline),
        calls,
        model.transcribe(&cfg.stt_model, &req.clip, req.language),
        |t| (Some(t.model.clone()), t.usage, None, Some(200)),
    )
    .await
    .map_err(|error| tracing::warn!(model = %cfg.stt_model, error = %assistant::error_info(&error).0, "voice STT failed"))
    .ok()?;
    let text = transcript.text.trim().to_owned();
    if text.is_empty() {
        let parse = VoiceParse {
            intent: Intent::None,
            ..VoiceParse::default()
        };
        return Some(ChainOk {
            parsed: Parsed {
                model: transcript.model,
                parse,
                usage: transcript.usage,
                finish_reason: None,
                http_status: 200,
            },
            stt_fallback: true,
        });
    }
    let transcript_only = |model_name: String| ChainOk {
        parsed: Parsed {
            model: model_name,
            parse: VoiceParse {
                transcript: text.clone(),
                language: req.language.as_str().into(),
                intent: Intent::Chat,
                confidence: 0.5,
                ..VoiceParse::default()
            },
            usage: Default::default(),
            finish_reason: None,
            http_status: 200,
        },
        stt_fallback: true,
    };
    if req.mode == Mode::Transcribe {
        return Some(transcript_only(transcript.model));
    }
    for (offset, slug) in models.iter().enumerate() {
        if expired() {
            return None;
        }
        let result = attempt(
            model,
            slug,
            ("text", stt_index + 1 + offset, deadline),
            calls,
            model.parse_text(slug, &text, hint, req.language),
            describe_parsed,
        )
        .await;
        match result {
            Ok(mut parsed) => {
                if parsed.parse.transcript.trim().is_empty() {
                    parsed.parse.transcript = text.clone();
                }
                return Some(ChainOk {
                    parsed,
                    stt_fallback: true,
                });
            }
            Err(error) => {
                tracing::warn!(model = %slug, error = %assistant::error_info(&error).0, "voice text model failed")
            }
        }
    }
    None
}

pub async fn create(
    state: &AppState,
    actor: &Actor,
    req: Request,
) -> ApiResult<(StatusCode, Value)> {
    let span = telemetry::utterance_span(req.id, req.mode.as_str(), &req.entry);
    span.in_scope(|| crate::telemetry::record_identity(actor));
    let result = run(state, actor, &req, &span)
        .instrument(span.clone())
        .await;
    if let Err(error) = &result {
        telemetry::failed(&span, error.code);
    }
    result
}

async fn run(
    state: &AppState,
    actor: &Actor,
    req: &Request,
    span: &tracing::Span,
) -> ApiResult<(StatusCode, Value)> {
    let voice = &state.voice;
    let model = voice.model.clone().ok_or_else(unavailable)?;
    let pool = crate::auth::data::pool(state)?;
    if let QuotaOutcome::Exceeded = quota::take(
        state,
        actor.store_id,
        voice.config.daily_utterances_per_store,
    )
    .await?
    {
        return Err(quota::exceeded());
    }
    // The unit is spent from here on; a server fault (503, failed write) gives it back.
    let result = process(state, actor, req, span, model, pool).await;
    if result.as_ref().is_err_and(|e| e.status.is_server_error()) {
        quota::refund(state, actor.store_id).await;
    }
    result
}

async fn process(
    state: &AppState,
    actor: &Actor,
    req: &Request,
    span: &tracing::Span,
    model: std::sync::Arc<dyn VoiceModel>,
    pool: &sqlx::PgPool,
) -> ApiResult<(StatusCode, Value)> {
    let voice = &state.voice;
    let hint = voice
        .hints
        .get(pool, actor.store_id, voice.config.hint_ttl)
        .await
        .map_err(db)?;
    let trace = assistant::trace_id(span);
    let mut calls = Vec::new();
    let chain = run_chain(voice, model.as_ref(), req, &hint, &mut calls).await;
    telemetry::generations(state, actor, req.id, &trace, &calls);
    let Some(ChainOk {
        parsed,
        stt_fallback,
    }) = chain
    else {
        return Err(unavailable());
    };
    let Parsed {
        model: answered,
        parse,
        ..
    } = parsed;
    let transcript = parse.transcript.trim().to_owned();
    let finish = |intent: &str, counts: Counts, model: Option<&str>| {
        telemetry::utterance_finished(
            span,
            req.audio_seconds,
            model,
            stt_fallback,
            intent,
            counts,
            req.started.elapsed().as_millis() as u64,
        );
    };
    if parse.intent == Intent::None || transcript.is_empty() {
        finish("none", Counts::default(), Some(&answered));
        return Err(no_speech());
    }
    let mut draft_out = None;
    if req.mode == Mode::Sale && parse.intent == Intent::Sale {
        draft_out = draft::build(state, actor, &parse).await?;
        if draft_out.is_none() {
            // The model heard a sale but named nothing sellable.
            finish("none", Counts::default(), Some(&answered));
            return Err(no_speech());
        }
    }
    let counts = draft_out
        .as_ref()
        .map_or_else(Counts::default, |d| d.counts);
    let latency_ms = req.started.elapsed().as_millis() as u64;
    let language = match parse.language.as_str() {
        "en" => "en",
        "vi" => "vi",
        _ => req.language.as_str(),
    };
    let parsed_json = serde_json::to_value(&parse).map_err(|_| ApiError::internal())?;
    let created_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO voice_utterances(id,store_id,member,mode,language,entry,intent,transcript,parsed,draft,model,stt_fallback,latency_ms)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING created_at",
    )
    .bind(req.id)
    .bind(actor.store_id)
    .bind(actor.member_id)
    .bind(req.mode.as_str())
    .bind(language)
    .bind(&req.entry)
    .bind(parse.intent.as_str())
    .bind(&transcript)
    .bind(&parsed_json)
    .bind(draft_out.as_ref().map(|d| &d.stored))
    .bind(&answered)
    .bind(stt_fallback)
    .bind(i32::try_from(latency_ms).unwrap_or(i32::MAX))
    .fetch_one(pool)
    .await
    .map_err(db)?;
    finish(parse.intent.as_str(), counts, Some(&answered));
    if draft_out.is_some() {
        telemetry::drafted(state, actor, &trace, counts, latency_ms, stt_fallback);
    }
    let mut body = json!({
        "id": req.id,
        "mode": req.mode.as_str(),
        "transcript": transcript,
        "language": language,
        "intent": parse.intent.as_str(),
        "confidence": if parse.confidence.is_finite() { parse.confidence.clamp(0.0, 1.0) } else { 0.0 },
        "model": answered,
        "stt_fallback": stt_fallback,
        "latency_ms": latency_ms,
        "created_at": created_at,
    });
    if let Some(d) = draft_out {
        body["sale_draft"] = d.api;
    }
    Ok((StatusCode::CREATED, body))
}
