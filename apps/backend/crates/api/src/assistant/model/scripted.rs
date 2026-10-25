//! A queued `ChatModel` mock for tests. Each call consumes the
//! next step; every request is recorded. It is public, not `#[cfg(test)]`, so integration tests
//! in `tests/` can use it.
use super::{ChatModel, ChatRequest, ChatResponse, ModelError, ToolCall, Usage};
use async_trait::async_trait;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Reply {
        content: String,
        /// Calls with an empty `id` get `call_1`, `call_2`, ... when the step is served.
        tool_calls: Vec<ToolCall>,
        /// Chunks sent to the stream before the reply is returned.
        deltas: Vec<String>,
        usage: Usage,
    },
    Error(ModelError),
    /// Wait, then serve the inner step.
    Delay(Duration, Box<Step>),
}
impl Step {
    /// A text reply, streamed as one chunk.
    pub fn text(content: impl Into<String>) -> Self {
        let content = content.into();
        Self::Reply {
            deltas: vec![content.clone()],
            content,
            tool_calls: Vec::new(),
            usage: Usage::default(),
        }
    }
    /// A text reply streamed in the given chunks.
    pub fn chunks<S: Into<String>>(chunks: impl IntoIterator<Item = S>) -> Self {
        let deltas: Vec<String> = chunks.into_iter().map(Into::into).collect();
        Self::Reply {
            content: deltas.concat(),
            deltas,
            tool_calls: Vec::new(),
            usage: Usage::default(),
        }
    }
    /// One tool call.
    pub fn tool(name: impl Into<String>, arguments: Value) -> Self {
        Self::tools([(name, arguments)])
    }
    /// Several tool calls in one model turn (run in parallel by the loop).
    pub fn tools<N: Into<String>>(calls: impl IntoIterator<Item = (N, Value)>) -> Self {
        Self::Reply {
            content: String::new(),
            tool_calls: calls
                .into_iter()
                .map(|(name, arguments)| ToolCall {
                    id: String::new(),
                    name: name.into(),
                    arguments: arguments.to_string(),
                })
                .collect(),
            deltas: Vec::new(),
            usage: Usage::default(),
        }
    }
    pub fn error(error: ModelError) -> Self {
        Self::Error(error)
    }
    pub fn delayed(delay: Duration, step: Step) -> Self {
        Self::Delay(delay, Box::new(step))
    }
    pub fn with_usage(self, new: Usage) -> Self {
        match self {
            Self::Reply {
                content,
                tool_calls,
                deltas,
                ..
            } => Self::Reply {
                content,
                tool_calls,
                deltas,
                usage: new,
            },
            Self::Delay(delay, inner) => Self::Delay(delay, Box::new(inner.with_usage(new))),
            error @ Self::Error(_) => error,
        }
    }
    /// Text that precedes the tool calls of a `tool` / `tools` step.
    pub fn with_text(self, text: impl Into<String>) -> Self {
        match self {
            Self::Reply {
                content,
                tool_calls,
                mut deltas,
                usage,
            } => {
                let text = text.into();
                deltas.insert(0, text.clone());
                Self::Reply {
                    content: text + &content,
                    tool_calls,
                    deltas,
                    usage,
                }
            }
            Self::Delay(delay, inner) => Self::Delay(delay, Box::new(inner.with_text(text))),
            error @ Self::Error(_) => error,
        }
    }
}

pub struct ScriptedModel {
    steps: Mutex<VecDeque<Step>>,
    requests: Mutex<Vec<ChatRequest>>,
    served_calls: Mutex<usize>,
}
impl ScriptedModel {
    pub fn new(steps: impl IntoIterator<Item = Step>) -> Self {
        Self {
            steps: Mutex::new(steps.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
            served_calls: Mutex::new(0),
        }
    }
    /// Every request received so far, oldest first.
    pub fn requests(&self) -> Vec<ChatRequest> {
        lock(&self.requests).clone()
    }
    /// Steps not yet consumed.
    pub fn remaining(&self) -> usize {
        lock(&self.steps).len()
    }
    pub fn push(&self, step: Step) {
        lock(&self.steps).push_back(step);
    }
    fn number_calls(&self, calls: &mut [ToolCall]) {
        let mut served = lock(&self.served_calls);
        for call in calls.iter_mut().filter(|call| call.id.is_empty()) {
            *served += 1;
            call.id = format!("call_{served}");
        }
    }
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[async_trait]
impl ChatModel for ScriptedModel {
    async fn chat(
        &self,
        request: &ChatRequest,
        deltas: &tokio::sync::mpsc::UnboundedSender<String>,
    ) -> Result<ChatResponse, ModelError> {
        lock(&self.requests).push(request.clone());
        let started = Instant::now();
        let mut step = lock(&self.steps)
            .pop_front()
            .ok_or_else(|| ModelError::Other {
                status: None,
                message: "scripted model has no step left".into(),
            })?;
        while let Step::Delay(delay, inner) = step {
            tokio::time::sleep(delay).await;
            step = *inner;
        }
        match step {
            Step::Error(error) => Err(error),
            Step::Reply {
                content,
                mut tool_calls,
                deltas: chunks,
                usage,
            } => {
                self.number_calls(&mut tool_calls);
                let time_to_first_token = (!chunks.is_empty()).then(|| started.elapsed());
                for chunk in chunks {
                    // A closed receiver means the client left; the reply is still returned.
                    let _ = deltas.send(chunk);
                }
                Ok(ChatResponse {
                    model: request.model.clone(),
                    finish_reason: if tool_calls.is_empty() {
                        "stop"
                    } else {
                        "tool_calls"
                    }
                    .into(),
                    content,
                    tool_calls,
                    usage,
                    http_status: 200,
                    time_to_first_token,
                })
            }
            Step::Delay(..) => unreachable!("delays are unwrapped above"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::model::{ChatMessage, ChatRole};
    use serde_json::json;

    fn request(model: &str) -> ChatRequest {
        ChatRequest {
            model: model.into(),
            messages: vec![ChatMessage::user("Chào")],
            tools: Vec::new(),
            max_tokens: 512,
            reasoning_effort: Some("low".into()),
        }
    }
    fn channel() -> (
        tokio::sync::mpsc::UnboundedSender<String>,
        tokio::sync::mpsc::UnboundedReceiver<String>,
    ) {
        tokio::sync::mpsc::unbounded_channel()
    }
    fn drain(mut rx: tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            out.push(chunk);
        }
        out
    }

    #[tokio::test]
    async fn text_steps_stream_and_report_usage() {
        let model = ScriptedModel::new([
            Step::text("Xin chào").with_usage(Usage {
                input_tokens: 12,
                output_tokens: 3,
            }),
            Step::chunks(["Bán ", "được ", "24 chai."]),
        ]);
        let (tx, rx) = channel();
        let reply = model.chat(&request("a/b:free"), &tx).await.unwrap();
        assert_eq!(reply.content, "Xin chào");
        assert_eq!(reply.model, "a/b:free");
        assert_eq!(reply.finish_reason, "stop");
        assert_eq!(reply.http_status, 200);
        assert_eq!(
            reply.usage,
            Usage {
                input_tokens: 12,
                output_tokens: 3
            }
        );
        assert!(reply.tool_calls.is_empty() && reply.time_to_first_token.is_some());
        assert_eq!(drain(rx), ["Xin chào"]);

        let (tx, rx) = channel();
        let reply = model.chat(&request("c/d:free"), &tx).await.unwrap();
        assert_eq!(reply.content, "Bán được 24 chai.");
        assert_eq!(drain(rx), ["Bán ", "được ", "24 chai."]);
        assert_eq!(model.remaining(), 0);
    }

    #[tokio::test]
    async fn tool_steps_get_sequential_call_ids() {
        let model = ScriptedModel::new([
            Step::tool("get_store_overview", json!({})),
            Step::tools([
                ("get_top_products", json!({"limit":3})),
                ("get_stock_levels", json!({"filter":"low"})),
            ]),
            Step::text("Xong"),
        ]);
        let (tx, rx) = channel();
        let first = model.chat(&request("m:free"), &tx).await.unwrap();
        assert_eq!(first.finish_reason, "tool_calls");
        assert_eq!(first.tool_calls.len(), 1);
        assert_eq!(first.tool_calls[0].id, "call_1");
        assert_eq!(first.tool_calls[0].name, "get_store_overview");
        assert_eq!(first.tool_calls[0].arguments, "{}");
        let second = model.chat(&request("m:free"), &tx).await.unwrap();
        let ids: Vec<_> = second.tool_calls.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["call_2", "call_3"]);
        assert_eq!(
            serde_json::from_str::<Value>(&second.tool_calls[0].arguments).unwrap(),
            json!({"limit":3})
        );
        let last = model.chat(&request("m:free"), &tx).await.unwrap();
        assert_eq!(last.finish_reason, "stop");
        assert_eq!(drain(rx), ["Xong"]);
    }

    #[tokio::test]
    async fn explicit_call_ids_and_leading_text_are_kept() {
        let step = Step::Reply {
            content: String::new(),
            tool_calls: vec![ToolCall {
                id: "fixed".into(),
                name: "get_store_overview".into(),
                arguments: "{}".into(),
            }],
            deltas: Vec::new(),
            usage: Usage::default(),
        }
        .with_text("Để tôi xem. ");
        let model = ScriptedModel::new([step]);
        let (tx, rx) = channel();
        let reply = model.chat(&request("m:free"), &tx).await.unwrap();
        assert_eq!(reply.tool_calls[0].id, "fixed");
        assert_eq!(reply.content, "Để tôi xem. ");
        assert_eq!(drain(rx), ["Để tôi xem. "]);
    }

    #[tokio::test]
    async fn errors_are_returned_and_consume_a_step() {
        let model = ScriptedModel::new([
            Step::error(ModelError::RateLimited {
                status: 429,
                message: "slow down".into(),
            }),
            Step::error(ModelError::Timeout),
            Step::text("ok"),
        ]);
        let (tx, rx) = channel();
        let error = model.chat(&request("a:free"), &tx).await.unwrap_err();
        assert!(matches!(error, ModelError::RateLimited { status: 429, .. }));
        assert_eq!(
            model.chat(&request("b:free"), &tx).await.unwrap_err(),
            ModelError::Timeout
        );
        assert_eq!(
            model.chat(&request("c:free"), &tx).await.unwrap().content,
            "ok"
        );
        assert_eq!(drain(rx), ["ok"]);
    }

    #[tokio::test]
    async fn an_empty_script_fails_with_other_and_still_records() {
        let model = ScriptedModel::new([]);
        let (tx, _rx) = channel();
        let error = model.chat(&request("a:free"), &tx).await.unwrap_err();
        assert!(matches!(error, ModelError::Other { status: None, .. }));
        assert!(!error.retryable());
        assert_eq!(model.requests().len(), 1);
        model.push(Step::text("late"));
        assert_eq!(
            model.chat(&request("a:free"), &tx).await.unwrap().content,
            "late"
        );
    }

    #[tokio::test]
    async fn requests_are_recorded_in_order() {
        let model = ScriptedModel::new([Step::text("a"), Step::text("b")]);
        let (tx, _rx) = channel();
        let mut first = request("one:free");
        first
            .messages
            .push(ChatMessage::assistant(Some("x".into()), vec![]));
        model.chat(&first, &tx).await.unwrap();
        model.chat(&request("two:free"), &tx).await.unwrap();
        let seen = model.requests();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], first);
        assert_eq!(seen[1].model, "two:free");
        assert_eq!(seen[0].messages[0].role, ChatRole::User);
    }

    #[tokio::test]
    async fn delay_waits_before_serving_the_inner_step() {
        let model = ScriptedModel::new([
            Step::delayed(Duration::from_millis(60), Step::text("slow")),
            Step::delayed(
                Duration::from_millis(20),
                Step::delayed(Duration::from_millis(30), Step::error(ModelError::Timeout)),
            ),
        ]);
        let (tx, rx) = channel();
        let started = Instant::now();
        let reply = model.chat(&request("a:free"), &tx).await.unwrap();
        assert_eq!(reply.content, "slow");
        assert!(started.elapsed() >= Duration::from_millis(60));
        assert!(reply.time_to_first_token.unwrap() >= Duration::from_millis(60));
        assert_eq!(drain(rx), ["slow"]);
        let started = Instant::now();
        assert_eq!(
            model.chat(&request("a:free"), &tx).await.unwrap_err(),
            ModelError::Timeout
        );
        assert!(started.elapsed() >= Duration::from_millis(50));
    }

    #[tokio::test]
    async fn a_dropped_receiver_does_not_fail_the_call() {
        let model = ScriptedModel::new([Step::text("still here")]);
        let (tx, rx) = channel();
        drop(rx);
        let reply = model.chat(&request("a:free"), &tx).await.unwrap();
        assert_eq!(reply.content, "still here");
    }

    #[test]
    fn modifiers_reach_through_delay_and_skip_errors() {
        let usage = Usage {
            input_tokens: 1,
            output_tokens: 2,
        };
        let delayed = Step::delayed(Duration::from_secs(1), Step::text("x")).with_usage(usage);
        match delayed {
            Step::Delay(_, inner) => match *inner {
                Step::Reply { usage: got, .. } => assert_eq!(got, usage),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        let error = Step::error(ModelError::Timeout)
            .with_usage(usage)
            .with_text("t");
        assert_eq!(error, Step::Error(ModelError::Timeout));
    }
}
