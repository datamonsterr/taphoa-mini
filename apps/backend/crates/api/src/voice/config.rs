//! Voice settings from the environment. Paid slugs are allowed here (the assistant accepts
//! only `:free` ones): one audio-native call per utterance is cheap and must be fast.
use anyhow::{Context, bail, ensure};
use std::time::Duration;

pub const DEFAULT_MODELS: &str = "google/gemini-3.1-flash-lite,google/gemini-2.5-flash-lite";
/// Text-only parse after the STT fallback.
pub const DEFAULT_PARSE_MODELS: &str = "google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite";
pub const DEFAULT_STT_MODEL: &str = "openai/whisper-large-v3-turbo";
/// Extra bytes allowed in the multipart body besides the audio part.
pub const MULTIPART_OVERHEAD: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VoiceProvider {
    #[default]
    OpenRouter,
    /// Deterministic local/e2e model; forbidden in production.
    Scripted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceConfig {
    /// Ordered audio-native models; the first that answers wins.
    pub models: Vec<String>,
    /// Text-only models for the parse after the STT fallback, in order.
    pub parse_models: Vec<String>,
    pub stt_model: String,
    pub daily_utterances_per_store: u32,
    pub max_seconds: u32,
    pub max_bytes: usize,
    /// Timeout of one model call.
    pub model_timeout: Duration,
    /// Deadline for the whole utterance, measured from the start of the request; the chain
    /// stops and the answer is 503 `voice_unavailable` once it passes.
    pub total_timeout: Duration,
    /// Honor `X-Taphoa-Eval-Model` (test environments only, never production).
    pub allow_eval_headers: bool,
    pub hint_ttl: Duration,
    /// Route only to zero-data-retention endpoints (some models have none).
    pub require_zdr: bool,
    pub provider: VoiceProvider,
}
impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            models: DEFAULT_MODELS.split(',').map(str::to_owned).collect(),
            parse_models: DEFAULT_PARSE_MODELS.split(',').map(str::to_owned).collect(),
            stt_model: DEFAULT_STT_MODEL.into(),
            daily_utterances_per_store: 300,
            max_seconds: 30,
            max_bytes: 1_048_576,
            model_timeout: Duration::from_secs(6),
            total_timeout: Duration::from_secs(8),
            allow_eval_headers: false,
            hint_ttl: Duration::from_secs(300),
            require_zdr: false,
            provider: VoiceProvider::OpenRouter,
        }
    }
}

fn slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.contains('/')
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

impl VoiceConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let get = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let positive = |name: &str| -> anyhow::Result<Option<u64>> {
            get(name)
                .map(|v| {
                    v.parse::<u64>()
                        .ok()
                        .filter(|n| *n > 0)
                        .with_context(|| format!("{name} must be a positive integer"))
                })
                .transpose()
        };
        let mut config = Self::default();
        if let Some(value) = get("VOICE_MODELS") {
            let models: Vec<String> = value.split(',').map(|s| s.trim().to_owned()).collect();
            ensure!(
                !models.is_empty() && models.len() <= 5 && models.iter().all(|m| slug(m)),
                "VOICE_MODELS must be 1-5 comma-separated provider/model slugs"
            );
            config.models = models;
        }
        if let Some(value) = get("VOICE_PARSE_MODELS") {
            let models: Vec<String> = value.split(',').map(|s| s.trim().to_owned()).collect();
            ensure!(
                !models.is_empty() && models.len() <= 5 && models.iter().all(|m| slug(m)),
                "VOICE_PARSE_MODELS must be 1-5 comma-separated provider/model slugs"
            );
            config.parse_models = models;
        }
        if let Some(value) = get("VOICE_STT_MODEL") {
            ensure!(
                slug(&value),
                "VOICE_STT_MODEL must be a provider/model slug"
            );
            config.stt_model = value;
        }
        if let Some(n) = positive("VOICE_DAILY_UTTERANCES_PER_STORE")? {
            config.daily_utterances_per_store =
                u32::try_from(n).context("VOICE_DAILY_UTTERANCES_PER_STORE is too large")?;
        }
        if let Some(n) = positive("VOICE_MAX_SECONDS")? {
            ensure!(n <= 300, "VOICE_MAX_SECONDS must be at most 300");
            config.max_seconds = n as u32;
        }
        if let Some(n) = positive("VOICE_MAX_BYTES")? {
            ensure!(
                n <= 8 * 1024 * 1024,
                "VOICE_MAX_BYTES must be at most 8388608"
            );
            config.max_bytes = n as usize;
        }
        if let Some(n) = positive("VOICE_MODEL_TIMEOUT_MS")? {
            config.model_timeout = Duration::from_millis(n);
        }
        if let Some(n) = positive("VOICE_TOTAL_TIMEOUT_MS")? {
            config.total_timeout = Duration::from_millis(n);
        }
        let flag =
            |name: &str| get(name).is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
        config.require_zdr = flag("VOICE_REQUIRE_ZDR");
        config.allow_eval_headers = flag("VOICE_ALLOW_EVAL_HEADERS");
        if let Some(value) = get("VOICE_MODEL_PROVIDER") {
            config.provider = match value.to_ascii_lowercase().as_str() {
                "openrouter" => VoiceProvider::OpenRouter,
                "scripted" => VoiceProvider::Scripted,
                _ => bail!("VOICE_MODEL_PROVIDER must be openrouter or scripted"),
            };
        }
        if config.provider == VoiceProvider::Scripted {
            // Fail closed: the scripted model answers from the clip itself, so it needs an
            // explicit opt-in; an unset environment name is not proof of a safe environment.
            ensure!(
                flag("VOICE_ALLOW_SCRIPTED"),
                "VOICE_MODEL_PROVIDER=scripted requires VOICE_ALLOW_SCRIPTED=1"
            );
            ensure!(
                !get("RAILWAY_ENVIRONMENT_NAME")
                    .is_some_and(|v| v.eq_ignore_ascii_case("production")),
                "VOICE_MODEL_PROVIDER=scripted is forbidden in production"
            );
            config.models = vec!["scripted/voice".into()];
            config.parse_models = vec!["scripted/voice".into()];
        }
        Ok(config)
    }
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lookup(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }
    #[test]
    fn defaults() {
        let c = VoiceConfig::from_lookup(lookup(&[])).unwrap();
        assert_eq!(c, VoiceConfig::default());
        assert_eq!(c.models.len(), 2);
        // 3.1 is faster and more accurate; 2.5 backs it up.
        assert_eq!(c.models[0], "google/gemini-3.1-flash-lite");
        assert_eq!(c.parse_models[0], "google/gemini-2.5-flash-lite");
        assert_eq!(c.daily_utterances_per_store, 300);
        assert_eq!((c.max_seconds, c.max_bytes), (30, 1_048_576));
        assert_eq!(c.model_timeout, Duration::from_secs(6));
        assert_eq!(c.total_timeout, Duration::from_secs(8));
        assert!(!c.allow_eval_headers, "eval headers are off by default");
    }
    #[test]
    fn overrides_and_paid_slugs() {
        let c = VoiceConfig::from_lookup(lookup(&[
            ("VOICE_MODELS", "a/b, c/d"),
            ("VOICE_PARSE_MODELS", "e/f"),
            ("VOICE_STT_MODEL", "x/y"),
            ("VOICE_DAILY_UTTERANCES_PER_STORE", "5"),
            ("VOICE_MAX_SECONDS", "10"),
            ("VOICE_MAX_BYTES", "2048"),
            ("VOICE_REQUIRE_ZDR", "true"),
            ("VOICE_ALLOW_EVAL_HEADERS", "1"),
            ("VOICE_TOTAL_TIMEOUT_MS", "2500"),
        ]))
        .unwrap();
        assert_eq!(c.models, ["a/b", "c/d"]);
        assert_eq!(c.parse_models, ["e/f"]);
        assert_eq!(c.stt_model, "x/y");
        assert_eq!(
            (
                c.daily_utterances_per_store,
                c.max_seconds,
                c.max_bytes,
                c.require_zdr
            ),
            (5, 10, 2048, true)
        );
        assert!(c.allow_eval_headers);
        assert_eq!(c.total_timeout, Duration::from_millis(2500));
    }
    #[test]
    fn rejects_bad_values() {
        for pairs in [
            &[("VOICE_MODELS", "noslash")][..],
            &[("VOICE_PARSE_MODELS", "noslash")],
            &[("VOICE_DAILY_UTTERANCES_PER_STORE", "0")],
            &[("VOICE_MAX_BYTES", "abc")],
            &[("VOICE_MODEL_PROVIDER", "other")],
        ] {
            let pairs: &'static [(&str, &str)] = Box::leak(pairs.to_vec().into_boxed_slice());
            assert!(
                VoiceConfig::from_lookup(lookup(pairs)).is_err(),
                "{pairs:?}"
            );
        }
    }
    #[test]
    fn scripted_forbidden_in_production() {
        // Without the explicit opt-in the scripted provider is refused anywhere.
        assert!(VoiceConfig::from_lookup(lookup(&[("VOICE_MODEL_PROVIDER", "scripted")])).is_err());
        let ok = VoiceConfig::from_lookup(lookup(&[
            ("VOICE_MODEL_PROVIDER", "scripted"),
            ("VOICE_ALLOW_SCRIPTED", "1"),
        ]))
        .unwrap();
        assert_eq!(ok.provider, VoiceProvider::Scripted);
        assert!(
            VoiceConfig::from_lookup(lookup(&[
                ("VOICE_MODEL_PROVIDER", "scripted"),
                ("VOICE_ALLOW_SCRIPTED", "1"),
                ("RAILWAY_ENVIRONMENT_NAME", "production")
            ]))
            .is_err()
        );
    }
}
