//! Scripted speech models: a step queue for tests (with audio fixtures recorded per call) and
//! a marker model for local/e2e runs with `VOICE_MODEL_PROVIDER=scripted`.
use super::model::{AudioClip, Intent, ModelUsage, Parsed, Transcribed, VoiceModel, VoiceParse};
use crate::assistant::{Language, model::ModelError};
use async_trait::async_trait;
use std::{
    collections::VecDeque,
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};

#[derive(Debug, Clone)]
pub enum Step {
    Parse(VoiceParse, ModelUsage),
    Transcript(String, ModelUsage),
    Error(ModelError),
    Delay(Duration, Box<Step>),
}
impl Step {
    pub fn parse(parse: VoiceParse) -> Self {
        Self::Parse(
            parse,
            ModelUsage {
                input_tokens: 300,
                output_tokens: 80,
                cost_usd: Some(0.0002),
            },
        )
    }
    pub fn transcript(text: impl Into<String>) -> Self {
        Self::Transcript(
            text.into(),
            ModelUsage {
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: Some(0.0001),
            },
        )
    }
    pub fn error(error: ModelError) -> Self {
        Self::Error(error)
    }
    pub fn unavailable() -> Self {
        Self::Error(ModelError::Unavailable {
            status: 503,
            message: "down".into(),
        })
    }
}

/// One call the fake received.
#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    Audio {
        model: String,
        audio: Vec<u8>,
        format: &'static str,
        hint: String,
    },
    Stt {
        model: String,
        audio_len: usize,
    },
    Text {
        model: String,
        transcript: String,
    },
}

pub struct ScriptedVoiceModel {
    steps: Mutex<VecDeque<Step>>,
    calls: Mutex<Vec<Call>>,
}
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
impl ScriptedVoiceModel {
    pub fn new(steps: impl IntoIterator<Item = Step>) -> Self {
        Self {
            steps: Mutex::new(steps.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }
    pub fn calls(&self) -> Vec<Call> {
        lock(&self.calls).clone()
    }
    pub fn remaining(&self) -> usize {
        lock(&self.steps).len()
    }
    async fn next(&self) -> Result<Step, ModelError> {
        let mut step = lock(&self.steps).pop_front().ok_or(ModelError::Other {
            status: None,
            message: "scripted voice model has no step left".into(),
        })?;
        while let Step::Delay(delay, inner) = step {
            tokio::time::sleep(delay).await;
            step = *inner;
        }
        Ok(step)
    }
}
fn wrong(kind: &str) -> ModelError {
    ModelError::Other {
        status: None,
        message: format!("scripted step does not fit a {kind} call"),
    }
}
#[async_trait]
impl VoiceModel for ScriptedVoiceModel {
    async fn parse_audio(
        &self,
        model: &str,
        clip: &AudioClip,
        hint: &str,
        _: Language,
    ) -> Result<Parsed, ModelError> {
        lock(&self.calls).push(Call::Audio {
            model: model.into(),
            audio: clip.bytes.clone(),
            format: clip.format,
            hint: hint.into(),
        });
        match self.next().await? {
            Step::Parse(parse, usage) => Ok(Parsed {
                model: model.into(),
                parse,
                usage,
                finish_reason: Some("stop".into()),
                http_status: 200,
            }),
            Step::Error(e) => Err(e),
            _ => Err(wrong("audio")),
        }
    }
    async fn transcribe(
        &self,
        model: &str,
        clip: &AudioClip,
        _: Language,
    ) -> Result<Transcribed, ModelError> {
        lock(&self.calls).push(Call::Stt {
            model: model.into(),
            audio_len: clip.bytes.len(),
        });
        match self.next().await? {
            Step::Transcript(text, usage) => Ok(Transcribed {
                model: model.into(),
                text,
                usage,
            }),
            Step::Error(e) => Err(e),
            _ => Err(wrong("stt")),
        }
    }
    async fn parse_text(
        &self,
        model: &str,
        transcript: &str,
        _: &str,
        _: Language,
    ) -> Result<Parsed, ModelError> {
        lock(&self.calls).push(Call::Text {
            model: model.into(),
            transcript: transcript.into(),
        });
        match self.next().await? {
            Step::Parse(parse, usage) => Ok(Parsed {
                model: model.into(),
                parse,
                usage,
                finish_reason: Some("stop".into()),
                http_status: 200,
            }),
            Step::Error(e) => Err(e),
            _ => Err(wrong("text")),
        }
    }
}

/// Local/e2e model: the clip carries its own answer as `VOICE_PARSE=<VoiceParse JSON>`
/// somewhere in its bytes. Without the marker it hears nothing (intent none).
pub struct MarkerVoiceModel;
const MARKER: &[u8] = b"VOICE_PARSE=";
fn embedded(bytes: &[u8]) -> VoiceParse {
    let Some(at) = bytes.windows(MARKER.len()).position(|w| w == MARKER) else {
        return VoiceParse {
            intent: Intent::None,
            ..VoiceParse::default()
        };
    };
    let rest = &bytes[at + MARKER.len()..];
    serde_json::Deserializer::from_slice(rest)
        .into_iter::<VoiceParse>()
        .next()
        .and_then(Result::ok)
        .unwrap_or_default()
}
fn marker_parsed(model: &str, parse: VoiceParse) -> Parsed {
    Parsed {
        model: model.into(),
        parse,
        usage: ModelUsage {
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: Some(0.0),
        },
        finish_reason: Some("stop".into()),
        http_status: 200,
    }
}
#[async_trait]
impl VoiceModel for MarkerVoiceModel {
    async fn parse_audio(
        &self,
        model: &str,
        clip: &AudioClip,
        _: &str,
        _: Language,
    ) -> Result<Parsed, ModelError> {
        Ok(marker_parsed(model, embedded(&clip.bytes)))
    }
    async fn transcribe(
        &self,
        model: &str,
        clip: &AudioClip,
        _: Language,
    ) -> Result<Transcribed, ModelError> {
        Ok(Transcribed {
            model: model.into(),
            text: embedded(&clip.bytes).transcript,
            usage: ModelUsage::default(),
        })
    }
    async fn parse_text(
        &self,
        model: &str,
        transcript: &str,
        _: &str,
        _: Language,
    ) -> Result<Parsed, ModelError> {
        Ok(marker_parsed(
            model,
            VoiceParse {
                transcript: transcript.into(),
                ..VoiceParse::default()
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn marker_model_reads_embedded_parse() {
        let mut bytes = b"\0\0ftypM4A xx".to_vec();
        bytes.extend_from_slice(br#"VOICE_PARSE={"transcript":"hai chai","intent":"sale","lines":[{"spoken":"hai chai","query":"chai","quantity":2}]}"#);
        let clip = AudioClip {
            bytes,
            format: "m4a",
        };
        let p = MarkerVoiceModel
            .parse_audio("m", &clip, "", Language::Vi)
            .await
            .unwrap();
        assert_eq!(p.parse.intent, Intent::Sale);
        assert_eq!(p.parse.lines[0].quantity, Some(2.0));
        let none = MarkerVoiceModel
            .parse_audio(
                "m",
                &AudioClip {
                    bytes: vec![1, 2],
                    format: "wav",
                },
                "",
                Language::Vi,
            )
            .await
            .unwrap();
        assert_eq!(none.parse.intent, Intent::None);
    }
    #[tokio::test]
    async fn scripted_records_calls_and_runs_out() {
        let model = ScriptedVoiceModel::new([Step::unavailable()]);
        let clip = AudioClip {
            bytes: vec![9],
            format: "ogg",
        };
        assert!(
            model
                .parse_audio("a/b", &clip, "h", Language::Vi)
                .await
                .is_err()
        );
        assert!(
            model
                .parse_audio("a/b", &clip, "h", Language::Vi)
                .await
                .is_err()
        );
        assert_eq!(model.calls().len(), 2);
    }
}
