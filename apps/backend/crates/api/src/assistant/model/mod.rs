//! The chat-model port. The agent loop (T2) calls it, `openrouter.rs` (T3) and the scripted mock
//! implement it. One call is one model on one HTTP request; fallback across models is the loop's job.
pub mod openrouter;
pub mod scripted;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One message of the model context. Serialized as-is into `assistant_messages.transcript`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Set on `Tool` messages: the id of the call this message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}
impl ChatMessage {
    fn plain(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::System, content)
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::User, content)
    }
    /// An assistant turn: text, tool calls, or both.
    pub fn assistant(content: Option<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content,
            tool_calls,
            tool_call_id: None,
        }
    }
    /// A tool result. `content` is JSON text and is data for the model, never instructions.
    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: Some(tool_call_id.into()),
            ..Self::plain(ChatRole::Tool, content)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON text from the model; the loop parses it and treats bad JSON as `InvalidToolCall`.
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments (an object schema).
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: u32,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    /// The model that answered, as reported by the provider.
    pub model: String,
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: String,
    pub usage: Usage,
    pub http_status: u16,
    pub time_to_first_token: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ModelError {
    /// 429 that is not the free daily quota: another model may still answer.
    #[error("model rate limited (HTTP {status}): {message}")]
    RateLimited { status: u16, message: String },
    /// 429 naming the free-model daily limit: no free model will answer until the next UTC day.
    #[error("free model daily quota exhausted: {message}")]
    DailyQuota { message: String },
    #[error("model unavailable (HTTP {status}): {message}")]
    Unavailable { status: u16, message: String },
    #[error("model request timed out")]
    Timeout,
    #[error("invalid tool call: {message}")]
    InvalidToolCall { message: String },
    /// The stream broke; `text_sent` says whether deltas already reached the client.
    #[error("model stream failed: {message}")]
    StreamFailed { message: String, text_sent: bool },
    #[error("model call failed: {message}")]
    Other {
        status: Option<u16>,
        message: String,
    },
}
impl ModelError {
    /// Whether the loop moves on to the next model in `ASSISTANT_MODELS`.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimited { .. }
                | Self::Unavailable { .. }
                | Self::Timeout
                | Self::InvalidToolCall { .. }
                | Self::StreamFailed {
                    text_sent: false,
                    ..
                }
        )
    }
    pub fn http_status(&self) -> Option<u16> {
        match self {
            Self::RateLimited { status, .. } | Self::Unavailable { status, .. } => Some(*status),
            Self::DailyQuota { .. } => Some(429),
            Self::Other { status, .. } => *status,
            Self::Timeout | Self::InvalidToolCall { .. } | Self::StreamFailed { .. } => None,
        }
    }
}

#[async_trait]
pub trait ChatModel: Send + Sync {
    /// Streams text deltas into `deltas` as they arrive; returns the assembled reply.
    async fn chat(
        &self,
        request: &ChatRequest,
        deltas: &tokio::sync::mpsc::UnboundedSender<String>,
    ) -> Result<ChatResponse, ModelError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retryable_follows_the_fallback_rule() {
        let message = || "x".to_owned();
        for (error, retryable, status) in [
            (
                ModelError::RateLimited {
                    status: 429,
                    message: message(),
                },
                true,
                Some(429),
            ),
            (
                ModelError::DailyQuota { message: message() },
                false,
                Some(429),
            ),
            (
                ModelError::Unavailable {
                    status: 503,
                    message: message(),
                },
                true,
                Some(503),
            ),
            (ModelError::Timeout, true, None),
            (
                ModelError::InvalidToolCall { message: message() },
                true,
                None,
            ),
            (
                ModelError::StreamFailed {
                    message: message(),
                    text_sent: false,
                },
                true,
                None,
            ),
            (
                ModelError::StreamFailed {
                    message: message(),
                    text_sent: true,
                },
                false,
                None,
            ),
            (
                ModelError::Other {
                    status: Some(401),
                    message: message(),
                },
                false,
                Some(401),
            ),
            (
                ModelError::Other {
                    status: None,
                    message: message(),
                },
                false,
                None,
            ),
        ] {
            assert_eq!(error.retryable(), retryable, "{error}");
            assert_eq!(error.http_status(), status, "{error}");
        }
    }

    #[test]
    fn transcript_messages_round_trip_and_stay_compact() {
        let call = ToolCall {
            id: "call_1".into(),
            name: "get_store_overview".into(),
            arguments: "{}".into(),
        };
        let transcript = vec![
            ChatMessage::assistant(None, vec![call]),
            ChatMessage::tool("call_1", r#"{"ok":true}"#),
            ChatMessage::assistant(Some("Xong".into()), vec![]),
        ];
        let value = serde_json::to_value(&transcript).unwrap();
        assert_eq!(
            value,
            json!([
                {"role":"assistant","content":null,
                 "tool_calls":[{"id":"call_1","name":"get_store_overview","arguments":"{}"}]},
                {"role":"tool","content":"{\"ok\":true}","tool_call_id":"call_1"},
                {"role":"assistant","content":"Xong"}
            ])
        );
        let back: Vec<ChatMessage> = serde_json::from_value(value).unwrap();
        assert_eq!(back, transcript);
    }

    #[test]
    fn messages_deserialize_without_optional_fields() {
        let message: ChatMessage =
            serde_json::from_value(json!({"role":"user","content":"Chào"})).unwrap();
        assert_eq!(message, ChatMessage::user("Chào"));
        assert!(
            serde_json::from_value::<ChatMessage>(json!({"role":"robot","content":"x"})).is_err()
        );
    }
}
