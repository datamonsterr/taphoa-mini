//! `ASSISTANT_*` variables. Every default is safe for local runs: free models only, no eval
//! headers, no PostHog survey.
use anyhow::{Context, bail, ensure};
use std::time::Duration;

/// Ordered free tool-capable fallbacks; gated models can fall through on HTTP 403/404.
pub const DEFAULT_MODELS: &str = "nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free";
/// `reasoning.effort` values OpenRouter documents (checked 2026-10-25).
const REASONING_EFFORTS: [&str; 7] = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

/// Which `ChatModel` main.rs builds: OpenRouter, or deterministic rules for local/e2e runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModelProvider {
    #[default]
    OpenRouter,
    Scripted,
}
impl ModelProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenRouter => "openrouter",
            Self::Scripted => "scripted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantConfig {
    /// Ordered `:free` OpenRouter fallbacks, or `["scripted"]` for local/e2e rules.
    pub models: Vec<String>,
    pub daily_messages_per_store: u32,
    /// Honour `X-Taphoa-Eval-*` headers (test and eval deployments only).
    pub allow_eval_headers: bool,
    pub reasoning_effort: String,
    pub model_provider: ModelProvider,
    pub max_model_calls: usize,
    pub tool_timeout: Duration,
    pub feedback_survey_id: Option<String>,
    pub feedback_question_id: Option<String>,
    pub feedback_comment_question_id: Option<String>,
}
impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            models: DEFAULT_MODELS.split(',').map(str::to_owned).collect(),
            daily_messages_per_store: 60,
            allow_eval_headers: false,
            reasoning_effort: "low".into(),
            model_provider: ModelProvider::default(),
            max_model_calls: 6,
            tool_timeout: Duration::from_secs(5),
            feedback_survey_id: None,
            feedback_question_id: None,
            feedback_comment_question_id: None,
        }
    }
}
impl AssistantConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        // A variable that is set but blank counts as unset, like an empty Railway value.
        let get = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let mut config = Self::default();
        if let Some(value) = get("ASSISTANT_MODELS") {
            config.models = parse_models(&value)?;
        }
        if let Some(value) = get("ASSISTANT_DAILY_MESSAGES_PER_STORE") {
            config.daily_messages_per_store = value
                .parse::<u32>()
                .ok()
                .filter(|cap| *cap > 0)
                .context("ASSISTANT_DAILY_MESSAGES_PER_STORE must be a positive integer")?;
        }
        config.allow_eval_headers = get("ASSISTANT_ALLOW_EVAL_HEADERS")
            .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
        if let Some(value) = get("ASSISTANT_REASONING_EFFORT") {
            let effort = value.to_ascii_lowercase();
            ensure!(
                REASONING_EFFORTS.contains(&effort.as_str()),
                "ASSISTANT_REASONING_EFFORT must be one of {}",
                REASONING_EFFORTS.join(", ")
            );
            config.reasoning_effort = effort;
        }
        if let Some(value) = get("ASSISTANT_MODEL_PROVIDER") {
            config.model_provider = match value.to_ascii_lowercase().as_str() {
                "openrouter" => ModelProvider::OpenRouter,
                "scripted" => ModelProvider::Scripted,
                _ => bail!("ASSISTANT_MODEL_PROVIDER must be openrouter or scripted"),
            };
        }
        if config.model_provider == ModelProvider::Scripted {
            ensure!(
                !get("RAILWAY_ENVIRONMENT_NAME")
                    .is_some_and(|v| v.eq_ignore_ascii_case("production")),
                "ASSISTANT_MODEL_PROVIDER=scripted is forbidden in production"
            );
            config.models = vec!["scripted".into()];
        }
        config.feedback_survey_id = get("ASSISTANT_FEEDBACK_SURVEY_ID");
        config.feedback_question_id = get("ASSISTANT_FEEDBACK_QUESTION_ID");
        config.feedback_comment_question_id = get("ASSISTANT_FEEDBACK_COMMENT_QUESTION_ID");
        Ok(config)
    }
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}
fn parse_models(value: &str) -> anyhow::Result<Vec<String>> {
    let models: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    ensure!(!models.is_empty(), "ASSISTANT_MODELS lists no model");
    for id in &models {
        ensure!(
            id.strip_suffix(":free")
                .is_some_and(|name| !name.is_empty()),
            "ASSISTANT_MODELS accepts only :free models, got {id}"
        );
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(vars: &[(&str, &str)]) -> anyhow::Result<AssistantConfig> {
        AssistantConfig::from_lookup(|name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    #[test]
    fn defaults_apply_without_variables() {
        let parsed = config(&[]).unwrap();
        assert_eq!(parsed, AssistantConfig::default());
        assert_eq!(
            parsed.models,
            [
                "nvidia/nemotron-3-ultra-550b-a55b:free",
                "google/gemma-4-31b-it:free",
                "nvidia/nemotron-3-super-120b-a12b:free"
            ]
        );
        assert_eq!(parsed.daily_messages_per_store, 60);
        assert!(!parsed.allow_eval_headers);
        assert_eq!(parsed.reasoning_effort, "low");
        assert_eq!(parsed.model_provider, ModelProvider::OpenRouter);
        assert_eq!(parsed.max_model_calls, 6);
        assert_eq!(parsed.tool_timeout, Duration::from_secs(5));
        assert!(parsed.feedback_survey_id.is_none());
    }

    #[test]
    fn parses_every_variable() {
        let parsed = config(&[
            ("ASSISTANT_MODELS", " a/b:free , c/d:free ,, "),
            ("ASSISTANT_DAILY_MESSAGES_PER_STORE", "120"),
            ("ASSISTANT_ALLOW_EVAL_HEADERS", "true"),
            ("ASSISTANT_REASONING_EFFORT", "Medium"),
            ("ASSISTANT_MODEL_PROVIDER", "scripted"),
            ("ASSISTANT_FEEDBACK_SURVEY_ID", "survey-1"),
            ("ASSISTANT_FEEDBACK_QUESTION_ID", "q-rating"),
            ("ASSISTANT_FEEDBACK_COMMENT_QUESTION_ID", "q-comment"),
        ])
        .unwrap();
        assert_eq!(parsed.models, ["scripted"]);
        assert_eq!(parsed.daily_messages_per_store, 120);
        assert!(parsed.allow_eval_headers);
        assert_eq!(parsed.reasoning_effort, "medium");
        assert_eq!(parsed.model_provider, ModelProvider::Scripted);
        assert_eq!(parsed.feedback_survey_id.as_deref(), Some("survey-1"));
        assert_eq!(parsed.feedback_question_id.as_deref(), Some("q-rating"));
        assert_eq!(
            parsed.feedback_comment_question_id.as_deref(),
            Some("q-comment")
        );
    }

    #[test]
    fn blank_values_count_as_unset() {
        let parsed = config(&[
            ("ASSISTANT_MODELS", "  "),
            ("ASSISTANT_DAILY_MESSAGES_PER_STORE", ""),
            ("ASSISTANT_REASONING_EFFORT", " "),
            ("ASSISTANT_MODEL_PROVIDER", ""),
            ("ASSISTANT_FEEDBACK_SURVEY_ID", " "),
        ])
        .unwrap();
        assert_eq!(parsed, AssistantConfig::default());
    }

    #[test]
    fn only_free_models_are_accepted() {
        for bad in [
            "openai/gpt-5",
            "a/b:free,openai/gpt-5",
            "a/b:free:extended",
            ":free",
            "a/b:FREE",
            ",",
        ] {
            let error = config(&[("ASSISTANT_MODELS", bad)])
                .unwrap_err()
                .to_string();
            assert!(error.contains("ASSISTANT_MODELS"), "{bad}: {error}");
        }
    }

    #[test]
    fn eval_headers_need_an_explicit_one_or_true() {
        for (value, expected) in [
            ("1", true),
            ("true", true),
            ("TRUE", true),
            ("0", false),
            ("false", false),
            ("yes", false),
            ("on", false),
            ("2", false),
        ] {
            let parsed = config(&[("ASSISTANT_ALLOW_EVAL_HEADERS", value)]).unwrap();
            assert_eq!(parsed.allow_eval_headers, expected, "{value}");
        }
    }

    #[test]
    fn invalid_numbers_effort_and_provider_are_rejected() {
        for (name, value) in [
            ("ASSISTANT_DAILY_MESSAGES_PER_STORE", "0"),
            ("ASSISTANT_DAILY_MESSAGES_PER_STORE", "-3"),
            ("ASSISTANT_DAILY_MESSAGES_PER_STORE", "many"),
            ("ASSISTANT_DAILY_MESSAGES_PER_STORE", "99999999999"),
            ("ASSISTANT_REASONING_EFFORT", "lwo"),
            ("ASSISTANT_MODEL_PROVIDER", "openai"),
        ] {
            let error = config(&[(name, value)]).unwrap_err().to_string();
            assert!(error.contains(name), "{name}={value}: {error}");
        }
    }
}
