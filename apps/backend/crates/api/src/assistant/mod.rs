//! The in-backend assistant (ADR 0005): threads, an agent loop over permission-filtered tools,
//! proposed actions the owner confirms, and next-step chips. Spec: docs/specs/assistant/.
pub mod actions;
pub mod config;
pub mod eval;
pub mod model;
pub mod quota;
pub mod threads;
pub mod tools;

use crate::AppState;
use axum::{
    Router,
    routing::{get, post},
};
use config::AssistantConfig;
use model::ChatModel;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Held in `AppState.assistant`. `model` is None until main.rs builds a client; the message
/// endpoint then answers `model_unavailable`.
#[derive(Clone, Default)]
pub struct AssistantState {
    pub config: Arc<AssistantConfig>,
    pub model: Option<Arc<dyn ChatModel>>,
}

/// Language of a turn: the system prompt and the Vietnamese-or-English wording follow it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    Vi,
    En,
}
impl Language {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vi => "vi",
            Self::En => "en",
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/assistant/actions/{action_id}/confirm",
            post(actions::confirm),
        )
        .route(
            "/v1/assistant/actions/{action_id}/reject",
            post(actions::reject),
        )
        .route(
            "/v1/assistant/threads",
            get(threads::list).post(threads::create),
        )
        .route(
            "/v1/assistant/threads/{thread_id}",
            get(threads::detail).delete(threads::delete),
        )
        .route(
            "/v1/assistant/messages/{message_id}/feedback",
            post(threads::feedback),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn language_serializes_as_vi_and_en() {
        assert_eq!(serde_json::to_value(Language::Vi).unwrap(), json!("vi"));
        assert_eq!(serde_json::to_value(Language::En).unwrap(), json!("en"));
        assert_eq!(
            serde_json::from_value::<Language>(json!("en")).unwrap(),
            Language::En
        );
        assert!(serde_json::from_value::<Language>(json!("fr")).is_err());
        assert_eq!(Language::default().as_str(), "vi");
    }

    #[test]
    fn default_state_has_no_model_and_default_config() {
        let state = AssistantState::default();
        assert!(state.model.is_none());
        assert_eq!(*state.config, AssistantConfig::default());
    }
}
