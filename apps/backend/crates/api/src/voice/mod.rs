//! Voice sale drafts from a spoken utterance (docs/specs/voice/voice.md).
//!
//! `POST /v1/voice/utterances` takes an m4a, WAV or Ogg clip, asks an audio-native model for
//! transcript and parse, re-checks quantities and prices, matches the catalog and returns a
//! sale draft. The audio is held in memory for the request only.
pub mod audio;
pub mod clean;
pub mod config;
mod draft;
pub mod hint;
pub mod matching;
pub mod model;
mod outcome;
pub mod quota;
pub mod rank;
pub mod retention;
pub mod rules;
pub mod scripted;
pub mod service;
pub mod speech;
pub mod telemetry;
pub mod text;

use crate::{ApiError, ApiResult, AppState, auth::Actor, error::ValidJson, multipart_error};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, State, multipart::MultipartRejection},
    http::StatusCode,
    routing::post,
};
use serde::Deserialize;
use serde_json::Value;
use std::{sync::Arc, time::Instant};
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

pub use config::{VoiceConfig, VoiceProvider};
pub use model::VoiceModel;

#[derive(Clone)]
pub struct VoiceState {
    pub config: Arc<VoiceConfig>,
    pub model: Option<Arc<dyn VoiceModel>>,
    pub hints: Arc<hint::HintCache>,
}
impl Default for VoiceState {
    fn default() -> Self {
        Self {
            config: Arc::new(VoiceConfig::default()),
            model: None,
            hints: Arc::default(),
        }
    }
}

const ENTRIES: [&str; 9] = [
    "bubble",
    "tile",
    "shortcut",
    "control",
    "action_button",
    "siri",
    "longpress",
    "chip",
    "chat",
];
/// Slack over `VOICE_MAX_SECONDS` for recorders that overshoot the cap by a few frames.
const DURATION_SLACK_SECONDS: f64 = 1.0;

pub fn router(config: &VoiceConfig) -> Router<AppState> {
    let limit = config.max_bytes + config::MULTIPART_OVERHEAD;
    Router::new()
        .route(
            "/v1/voice/utterances",
            post(create_utterance)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(limit))
                .layer(RequestBodyLimitLayer::new(limit)),
        )
        .route(
            "/v1/voice/utterances/{utterance_id}/outcome",
            post(post_outcome),
        )
}

fn bad(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "validation_failed", message)
}

#[derive(Deserialize)]
struct ContextField {
    entry: String,
    #[serde(default)]
    screen: String,
    #[serde(default)]
    #[allow(dead_code)]
    thread_id: Option<Uuid>,
}

async fn create_utterance(
    State(state): State<AppState>,
    actor: Actor,
    headers: axum::http::HeaderMap,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let started = Instant::now();
    let max_bytes = state.voice.config.max_bytes;
    let mut multipart = multipart.map_err(|_| bad("expected a multipart form"))?;
    let (mut audio, mut mode, mut language, mut context) =
        (None::<Vec<u8>>, None, None, None::<ContextField>);
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("audio") if audio.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len() + chunk.len() > max_bytes {
                        return Err(ApiError::new(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "payload_too_large",
                            "audio upload too large",
                        ));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                audio = Some(bytes);
            }
            Some(name @ ("mode" | "language" | "context")) => {
                let name = name.to_owned();
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len() + chunk.len() > 1024 {
                        return Err(bad("form field too long"));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let text =
                    String::from_utf8(bytes).map_err(|_| bad("form fields must be UTF-8"))?;
                match name.as_str() {
                    "mode" if mode.is_none() => mode = Some(text),
                    "language" if language.is_none() => language = Some(text),
                    "context" if context.is_none() => {
                        context = Some(serde_json::from_str(&text).map_err(|_| {
                            bad("context must be a JSON object with entry and screen")
                        })?);
                    }
                    _ => return Err(bad("duplicate form field")),
                }
            }
            _ => return Err(bad("unexpected form field")),
        }
    }
    let mode = match mode.as_deref() {
        Some("sale") => service::Mode::Sale,
        Some("transcribe") => service::Mode::Transcribe,
        _ => return Err(bad("mode must be sale or transcribe")),
    };
    let language = match language.as_deref() {
        None | Some("vi") => crate::assistant::Language::Vi,
        Some("en") => crate::assistant::Language::En,
        _ => return Err(bad("language must be vi or en")),
    };
    let entry = match context {
        Some(c) if ENTRIES.contains(&c.entry.as_str()) && c.screen.chars().count() <= 60 => c.entry,
        Some(_) => return Err(bad("context.entry is not a known entry point")),
        None => "chat".to_owned(),
    };
    let bytes = audio
        .filter(|b| !b.is_empty())
        .ok_or_else(|| bad("audio is required"))?;
    let format = audio::detect(&bytes).ok_or_else(|| {
        ApiError::bad_request("unsupported_format", "expected m4a, WAV or Ogg audio")
    })?;
    let audio_seconds = audio::duration_seconds(&bytes, format);
    let limit = f64::from(state.voice.config.max_seconds) + DURATION_SLACK_SECONDS;
    let too_long = match audio_seconds {
        Some(seconds) => seconds > limit,
        // Unreadable metadata: fall back to a worst-case size estimate.
        None => audio::exceeds_size_estimate(bytes.len(), state.voice.config.max_seconds),
    };
    if too_long {
        return Err(ApiError::bad_request(
            "audio_too_long",
            "audio is longer than the allowed duration",
        ));
    }
    let request = service::Request {
        id: Uuid::now_v7(),
        mode,
        language,
        entry,
        clip: model::AudioClip {
            bytes,
            format: format.as_str(),
        },
        audio_seconds,
        model_override: eval_model(&state, &headers),
        started,
    };
    let (status, body) = service::create(&state, &actor, request).await?;
    Ok((status, Json(body)))
}

async fn post_outcome(
    State(state): State<AppState>,
    actor: Actor,
    Path(utterance_id): Path<String>,
    ValidJson(body): ValidJson<outcome::OutcomeRequest>,
) -> ApiResult<StatusCode> {
    let id: Uuid = utterance_id.parse().map_err(|_| ApiError::not_found())?;
    outcome::record(&state, &actor, id, body).await
}

/// V5 eval runs pin the model with `X-Taphoa-Eval-Model`. Ignored unless
/// `VOICE_ALLOW_EVAL_HEADERS` is on, and then only for a slug already configured in
/// `VOICE_MODELS` or `VOICE_STT_MODEL`, so the header cannot route traffic to an arbitrary model.
fn eval_model(state: &AppState, headers: &axum::http::HeaderMap) -> Option<String> {
    let config = &state.voice.config;
    if !config.allow_eval_headers {
        return None;
    }
    let slug = headers.get("x-taphoa-eval-model")?.to_str().ok()?.trim();
    (config.models.iter().any(|m| m == slug) || config.stt_model == slug).then(|| slug.to_owned())
}
