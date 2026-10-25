//! One streaming OpenRouter chat completion per model attempt. Fallback belongs to the loop.
use super::{ChatModel, ChatRequest, ChatResponse, ModelError, ToolCall, Usage};
use anyhow::{Context, ensure};
use async_trait::async_trait;
use reqwest::{
    Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio::{
    sync::mpsc::UnboundedSender,
    time::{Instant, timeout, timeout_at},
};

const DEFAULT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const MAX_EVENT_BYTES: usize = 1024 * 1024;

// Intentionally no Debug: configuration contains an API key.
pub struct OpenRouterConfig {
    pub api_key: String,
    pub url: String,
    pub first_token_timeout: Duration,
    pub timeout: Duration,
}
impl OpenRouterConfig {
    /// A missing key disables the provider; malformed settings with a key fail startup.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Option<Self>> {
        let get = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let Some(api_key) = get("OPENROUTER_API_KEY") else {
            return Ok(None);
        };
        let duration = |name, default| -> anyhow::Result<Duration> {
            let ms = get(name)
                .map_or(Ok(default), |value| value.parse::<u64>())
                .ok()
                .filter(|ms| *ms > 0)
                .with_context(|| format!("{name} must be a positive integer"))?;
            Ok(Duration::from_millis(ms))
        };
        let config = Self {
            api_key,
            url: get("ASSISTANT_OPENROUTER_URL").unwrap_or_else(|| DEFAULT_URL.into()),
            first_token_timeout: duration("ASSISTANT_FIRST_TOKEN_TIMEOUT_MS", 20_000)?,
            timeout: duration("ASSISTANT_MODEL_TIMEOUT_MS", 60_000)?,
        };
        config.validate()?;
        Ok(Some(config))
    }
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
    fn validate(&self) -> anyhow::Result<Url> {
        ensure!(
            !self.api_key.trim().is_empty(),
            "OPENROUTER_API_KEY must not be blank"
        );
        ensure!(
            !self.first_token_timeout.is_zero() && !self.timeout.is_zero(),
            "assistant model timeouts must be positive"
        );
        let url = Url::parse(&self.url)
            .ok()
            .context("ASSISTANT_OPENROUTER_URL must be an HTTP(S) URL")?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "ASSISTANT_OPENROUTER_URL must be an HTTP(S) URL without credentials or a fragment"
        );
        Ok(url)
    }
}

pub struct OpenRouterChat {
    client: reqwest::Client,
    url: Url,
    first_token_timeout: Duration,
    timeout: Duration,
}
impl OpenRouterChat {
    pub fn new(config: OpenRouterConfig) -> anyhow::Result<Self> {
        let url = config.validate()?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .ok()
            .context("OPENROUTER_API_KEY is not a valid header value")?;
        authorization.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-title", HeaderValue::from_static("taphoa-mini"));
        headers.insert(
            "http-referer",
            HeaderValue::from_static("https://taphoa-mini.app"),
        );
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(config.timeout)
            .build()
            .context("could not build assistant HTTP client")?;
        Ok(Self {
            client,
            url,
            first_token_timeout: config.first_token_timeout,
            timeout: config.timeout,
        })
    }
    /// Available for the model-attempt span without exposing the URL or API key.
    pub fn server_address(&self) -> &str {
        self.url.host_str().unwrap_or_default()
    }
    async fn complete(
        &self,
        request: &ChatRequest,
        deltas: &UnboundedSender<String>,
    ) -> Result<ChatResponse, ModelError> {
        let body = request_body(request);
        let started = Instant::now();
        let first_deadline = started + self.first_token_timeout;
        let mut response = timeout_at(
            first_deadline,
            self.client.post(self.url.clone()).json(&body).send(),
        )
        .await
        .map_err(|_| ModelError::Timeout)?
        .map_err(|error| transport(error, false))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| transport(error, false))?
            {
                if bytes.len().saturating_add(chunk.len()) > MAX_EVENT_BYTES {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            return Err(http_error(status, &bytes));
        }
        let mut parsed = Completion::new(request.model.clone(), status);
        let mut sse = SseBuffer::default();
        loop {
            let chunk = if parsed.response.time_to_first_token.is_none() {
                timeout_at(first_deadline, response.chunk())
                    .await
                    .map_err(|_| ModelError::Timeout)?
            } else {
                response.chunk().await
            }
            .map_err(|error| transport(error, parsed.text_sent))?;
            let Some(chunk) = chunk else {
                return Err(parsed.failed("stream ended before [DONE]"));
            };
            for byte in chunk {
                if let Some(event) = sse.push(byte).map_err(|message| parsed.failed(message))?
                    && parsed.event(&event, deltas, started)?
                {
                    return parsed.finish();
                }
            }
        }
    }
}
#[async_trait]
impl ChatModel for OpenRouterChat {
    async fn chat(
        &self,
        request: &ChatRequest,
        deltas: &UnboundedSender<String>,
    ) -> Result<ChatResponse, ModelError> {
        timeout(self.timeout, self.complete(request, deltas))
            .await
            .map_err(|_| ModelError::Timeout)?
    }
}

fn request_body(request: &ChatRequest) -> Value {
    let messages: Vec<_> = request
        .messages
        .iter()
        .map(|message| {
            let mut value = json!({"role": message.role, "content": message.content});
            if !message.tool_calls.is_empty() {
                let calls: Vec<_> = message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": call.arguments},
                        })
                    })
                    .collect();
                value["tool_calls"] = json!(calls);
            }
            if let Some(id) = &message.tool_call_id {
                value["tool_call_id"] = json!(id);
            }
            value
        })
        .collect();
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "tool_choice": "auto",
        "stream": true,
        "max_tokens": request.max_tokens,
    });
    if !request.tools.is_empty() {
        let tools: Vec<_> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }
    if let Some(effort) = &request.reasoning_effort {
        body["reasoning"] = json!({"effort": effort});
    }
    // Usage is always present in the final chunk (OpenRouter docs checked 2026-10-26).
    body
}
fn transport(error: reqwest::Error, text_sent: bool) -> ModelError {
    if error.is_timeout() {
        ModelError::Timeout
    } else {
        ModelError::StreamFailed {
            message: "model transport failed".into(),
            text_sent,
        }
    }
}
fn http_error(status: u16, bytes: &[u8]) -> ModelError {
    let body: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let error = &body["error"];
    let message = error["message"]
        .as_str()
        .unwrap_or("model HTTP request failed")
        .to_owned();
    let details = error.to_string().to_ascii_lowercase();
    match status {
        429 if ["per-day", "per day", "free-models-per-day"]
            .iter()
            .any(|needle| details.contains(needle)) =>
        {
            ModelError::DailyQuota { message }
        }
        429 => ModelError::RateLimited { status, message },
        408 | 500..=599 => ModelError::Unavailable { status, message },
        _ => ModelError::Other {
            status: Some(status),
            message,
        },
    }
}

/// Buffer bytes until complete lines, so split UTF-8 codepoints and CRLF are safe. Each SSE
/// event may have multiple data fields; comments and unknown fields do not contribute data.
#[derive(Default)]
struct SseBuffer {
    line: Vec<u8>,
    data: String,
}
impl SseBuffer {
    fn push(&mut self, byte: u8) -> Result<Option<String>, &'static str> {
        if self.line.len() + self.data.len() >= MAX_EVENT_BYTES {
            return Err("SSE event too large");
        }
        if byte != b'\n' {
            self.line.push(byte);
            return Ok(None);
        }
        let line = std::mem::take(&mut self.line);
        let line = std::str::from_utf8(&line).map_err(|_| "invalid SSE encoding")?;
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if self.data.is_empty() {
                return Ok(None);
            }
            self.data.pop(); // Last data field's newline is not part of the payload.
            return Ok(Some(std::mem::take(&mut self.data)));
        }
        if let Some(data) = line.strip_prefix("data:") {
            self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
            self.data.push('\n');
        }
        Ok(None)
    }
}
struct Completion {
    response: ChatResponse,
    calls: BTreeMap<u64, ToolCall>,
    text_sent: bool,
}
impl Completion {
    fn new(model: String, http_status: u16) -> Self {
        Self {
            response: ChatResponse {
                model,
                content: String::new(),
                tool_calls: vec![],
                finish_reason: String::new(),
                usage: Usage::default(),
                http_status,
                time_to_first_token: None,
            },
            calls: BTreeMap::new(),
            text_sent: false,
        }
    }
    fn failed(&self, message: &str) -> ModelError {
        ModelError::StreamFailed {
            message: message.into(),
            text_sent: self.text_sent,
        }
    }
    fn event(
        &mut self,
        data: &str,
        deltas: &UnboundedSender<String>,
        started: Instant,
    ) -> Result<bool, ModelError> {
        if data == "[DONE]" {
            return Ok(true);
        }
        let value: Value =
            serde_json::from_str(data).map_err(|_| self.failed("invalid stream JSON"))?;
        let choice = &value["choices"][0];
        if value.get("error").is_some_and(|error| !error.is_null())
            || choice["finish_reason"] == "error"
        {
            return Err(self.failed("provider failed during streaming"));
        }
        if let Some(model) = value["model"].as_str() {
            self.response.model = model.to_owned();
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.response.usage = Usage {
                input_tokens: usage["prompt_tokens"]
                    .as_u64()
                    .and_then(|n| n.try_into().ok())
                    .unwrap_or_default(),
                output_tokens: usage["completion_tokens"]
                    .as_u64()
                    .and_then(|n| n.try_into().ok())
                    .unwrap_or_default(),
            };
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.response.finish_reason = reason.to_owned();
        }
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
            self.response
                .time_to_first_token
                .get_or_insert_with(|| started.elapsed());
            self.response.content.push_str(text);
            self.text_sent |= deltas.send(text.to_owned()).is_ok();
        }
        if let Some(calls) = delta["tool_calls"]
            .as_array()
            .filter(|calls| !calls.is_empty())
        {
            self.response
                .time_to_first_token
                .get_or_insert_with(|| started.elapsed());
            for fragment in calls {
                let index =
                    fragment["index"]
                        .as_u64()
                        .ok_or_else(|| ModelError::InvalidToolCall {
                            message: "tool call has no index".into(),
                        })?;
                let call = self.calls.entry(index).or_insert_with(|| ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
                if let Some(id) = fragment["id"].as_str() {
                    call.id.push_str(id);
                }
                if let Some(name) = fragment["function"]["name"].as_str() {
                    call.name.push_str(name);
                }
                if let Some(arguments) = fragment["function"]["arguments"].as_str() {
                    call.arguments.push_str(arguments);
                }
            }
        }
        Ok(false)
    }
    fn finish(mut self) -> Result<ChatResponse, ModelError> {
        if self.response.finish_reason.is_empty() {
            return Err(self.failed("stream has no finish reason"));
        }
        for mut call in self.calls.into_values() {
            if call.arguments.is_empty() {
                call.arguments = "{}".into();
            }
            if call.id.is_empty()
                || call.name.is_empty()
                || serde_json::from_str::<Value>(&call.arguments).is_err()
            {
                return Err(ModelError::InvalidToolCall {
                    message: "incomplete tool call or invalid arguments JSON".into(),
                });
            }
            self.response.tool_calls.push(call);
        }
        Ok(self.response)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ChatMessage, ToolSpec};
    use super::*;
    use axum::{
        Json, Router,
        body::{Body, Bytes},
        http::{HeaderMap, Response, StatusCode},
        routing::post,
    };
    use futures_util::{StreamExt, stream};
    use serde_json::{Value, json};
    use std::{convert::Infallible, time::Instant};
    use tokio::{sync::mpsc, task::JoinHandle};

    struct Mock {
        url: String,
        requests: mpsc::UnboundedReceiver<(HeaderMap, Value)>,
        task: JoinHandle<()>,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn mock(status: u16, chunks: Vec<(u64, Vec<u8>)>, header_delay: u64) -> Mock {
        let (tx, requests) = mpsc::unbounded_channel();
        let router = Router::new().route(
            "/chat",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let chunks = chunks.clone();
                let tx = tx.clone();
                async move {
                    tx.send((headers, body)).unwrap();
                    tokio::time::sleep(Duration::from_millis(header_delay)).await;
                    let body =
                        Body::from_stream(stream::iter(chunks).then(|(delay, bytes)| async move {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                            Ok::<_, Infallible>(Bytes::from(bytes))
                        }));
                    let mut response = Response::builder();
                    if status == 302 {
                        response = response.header("location", "/chat");
                    }
                    response
                        .status(StatusCode::from_u16(status).unwrap())
                        .header("content-type", "text/event-stream")
                        .body(body)
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Mock {
            url,
            requests,
            task,
        }
    }
    fn config(vars: &[(&str, &str)]) -> anyhow::Result<Option<OpenRouterConfig>> {
        OpenRouterConfig::from_lookup(|name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).into())
        })
    }
    fn client(mock: &Mock, first: u64, total: u64) -> OpenRouterChat {
        OpenRouterChat::new(OpenRouterConfig {
            api_key: "test-key".into(),
            url: mock.url.clone(),
            first_token_timeout: Duration::from_millis(first),
            timeout: Duration::from_millis(total),
        })
        .unwrap()
    }
    fn request() -> ChatRequest {
        ChatRequest {
            model: "test/model:free".into(),
            messages: vec![ChatMessage::system("rules"), ChatMessage::user("hello")],
            tools: vec![],
            max_tokens: 123,
            reasoning_effort: None,
        }
    }
    fn event(value: Value) -> String {
        format!("data: {value}\r\n\r\n")
    }
    fn delta(value: Value, finish: Value) -> String {
        event(
            json!({"model":"served/model:free", "choices":[{"delta":value,"finish_reason":finish}]}),
        )
    }
    fn text() -> String {
        delta(json!({"content":"Chào"}), json!(null))
    }
    fn end() -> String {
        delta(json!({}), json!("stop")) + "data: [DONE]\r\n\r\n"
    }
    async fn run(mock: &Mock) -> (Result<ChatResponse, ModelError>, Vec<String>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = client(mock, 5000, 10000).chat(&request(), &tx).await;
        let mut deltas = vec![];
        while let Ok(delta) = rx.try_recv() {
            deltas.push(delta);
        }
        (result, deltas)
    }
    async fn canned(status: u16, body: String) -> Mock {
        mock(status, vec![(0, body.into_bytes())], 0).await
    }

    #[tokio::test]
    async fn text_comments_split_lines_and_usage() {
        let usage = event(
            json!({"model":"served/model:free", "choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}),
        );
        let body = format!(
            ": OPENROUTER PROCESSING\r\n\r\n{}{}{}data: [DONE]\r\n\r\n",
            text(),
            delta(json!({"content":"!"}), json!("stop")),
            usage
        );
        // One byte per body frame also splits the UTF-8 content and CRLF boundaries.
        let chunks = body.bytes().map(|byte| (0, vec![byte])).collect();
        let mock = mock(200, chunks, 0).await;
        let (response, deltas) = run(&mock).await;
        let response = response.unwrap();
        assert_eq!(deltas, ["Chào", "!"]);
        assert_eq!(response.content, "Chào!");
        assert_eq!(response.model, "served/model:free");
        assert_eq!(response.finish_reason, "stop");
        assert_eq!(
            response.usage,
            Usage {
                input_tokens: 11,
                output_tokens: 7
            }
        );
        assert_eq!(response.http_status, 200);
        assert!(response.time_to_first_token.is_some());
        assert!(response.tool_calls.is_empty());
    }

    #[tokio::test]
    async fn parallel_tool_calls_assemble_interleaved_fragments() {
        let body = delta(
            json!({"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":""}},{"index":0,"id":"a","function":{"name":"first","arguments":"{\"x\":"}}]}),
            json!(null),
        ) + &delta(
            json!({"tool_calls":[{"index":0,"function":{"arguments":"42}"}},{"index":1,"function":{"arguments":""}}]}),
            json!("tool_calls"),
        ) + "data: [DONE]\n\n";
        let mock = canned(200, body).await;
        let (response, deltas) = run(&mock).await;
        let response = response.unwrap();
        assert!(deltas.is_empty());
        assert_eq!(
            response.tool_calls,
            [
                ToolCall {
                    id: "a".into(),
                    name: "first".into(),
                    arguments: "{\"x\":42}".into()
                },
                ToolCall {
                    id: "b".into(),
                    name: "second".into(),
                    arguments: "{}".into()
                }
            ]
        );
        assert_eq!(response.finish_reason, "tool_calls");
        assert!(response.time_to_first_token.is_some());
    }

    #[tokio::test]
    async fn request_body_and_headers_use_openai_format() {
        let mut mock = canned(200, text() + &end()).await;
        let mut req = request();
        req.tools.push(ToolSpec {
            name: "lookup".into(),
            description: "Lookup".into(),
            parameters: json!({"type":"object"}),
        });
        req.messages.push(ChatMessage::assistant(
            None,
            vec![ToolCall {
                id: "a".into(),
                name: "lookup".into(),
                arguments: "{}".into(),
            }],
        ));
        req.messages.push(ChatMessage::tool("a", "{\"ok\":true}"));
        req.reasoning_effort = Some("low".into());
        let (tx, _rx) = mpsc::unbounded_channel();
        client(&mock, 1000, 3000).chat(&req, &tx).await.unwrap();
        let (headers, body) = mock.requests.recv().await.unwrap();
        assert_eq!(headers["authorization"], "Bearer test-key");
        assert_eq!(headers["x-title"], "taphoa-mini");
        assert_eq!(headers["http-referer"], "https://taphoa-mini.app");
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(
            body,
            json!({"model":"test/model:free","messages":[{"role":"system","content":"rules"},{"role":"user","content":"hello"},{"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"a","content":"{\"ok\":true}"}],"tools":[{"type":"function","function":{"name":"lookup","description":"Lookup","parameters":{"type":"object"}}}],"tool_choice":"auto","stream":true,"max_tokens":123,"reasoning":{"effort":"low"}})
        );
    }
    #[tokio::test]
    async fn empty_tools_and_reasoning_are_omitted() {
        let mut mock = canned(200, end()).await;
        let response = run(&mock).await.0.unwrap();
        assert_eq!(response.time_to_first_token, None);
        let (_, body) = mock.requests.recv().await.unwrap();
        assert!(body.get("tools").is_none());
        assert!(body.get("reasoning").is_none());
        assert!(body.get("usage").is_none());
    }
    #[tokio::test]
    async fn http_status_mapping_and_daily_quota() {
        for (status, error, expected) in [
            (429, json!({"message":"Rate limit exceeded"}), "rate"),
            (
                429,
                json!({"message":"FREE-MODELS-PER-DAY limit reached"}),
                "daily",
            ),
            (
                429,
                json!({"message":"Free requests PER DAY exceeded"}),
                "daily",
            ),
            (
                429,
                json!({"message":"Limited","metadata":{"limit":"PER-DAY"}}),
                "daily",
            ),
            (502, json!({"message":"bad gateway"}), "unavailable"),
            (503, json!({"message":"unavailable"}), "unavailable"),
            (408, json!({"message":"timeout"}), "unavailable"),
            (400, json!({"message":"bad request"}), "other"),
            (401, json!({"message":"unauthorized"}), "other"),
            (402, json!({"message":"credits"}), "other"),
        ] {
            let mut mock = canned(status, json!({"error":error}).to_string()).await;
            let error = run(&mock).await.0.unwrap_err();
            mock.requests.try_recv().unwrap();
            assert!(mock.requests.try_recv().is_err());
            assert_eq!(error.http_status(), Some(status));
            assert!(
                matches!(
                    (&error, expected),
                    (ModelError::RateLimited { .. }, "rate")
                        | (ModelError::DailyQuota { .. }, "daily")
                        | (ModelError::Unavailable { .. }, "unavailable")
                        | (ModelError::Other { .. }, "other")
                ),
                "{error:?}"
            );
        }
    }
    #[tokio::test]
    async fn midstream_error_before_and_after_text() {
        for prefix in [String::new(), text()] {
            let sent = !prefix.is_empty();
            let error = event(
                json!({"error":{"code":502,"message":"upstream failed"},"choices":[{"finish_reason":"error"}]}),
            );
            let mock = canned(200, prefix + &error + "data: [DONE]\n\n").await;
            let (error, deltas) = run(&mock).await;
            assert!(matches!(error,Err(ModelError::StreamFailed{text_sent,..}) if text_sent==sent));
            assert_eq!(!deltas.is_empty(), sent);
        }
    }
    #[tokio::test]
    async fn invalid_tool_json_is_rejected() {
        let body = delta(
            json!({"tool_calls":[{"index":0,"id":"a","function":{"name":"lookup","arguments":"{oops"}}]}),
            json!("tool_calls"),
        ) + "data: [DONE]\n\n";
        let mock = canned(200, body).await;
        assert!(matches!(
            run(&mock).await.0,
            Err(ModelError::InvalidToolCall { .. })
        ));
    }
    #[tokio::test]
    async fn missing_done_or_finish_reason_is_stream_failure() {
        for body in [
            text() + &delta(json!({}), json!("stop")),
            text() + "data: [DONE]\n\n",
            String::new(),
        ] {
            let mock = canned(200, body).await;
            assert!(matches!(
                run(&mock).await.0,
                Err(ModelError::StreamFailed { .. })
            ));
        }
    }
    #[tokio::test]
    async fn malformed_sse_preserves_text_sent() {
        let mock = canned(200, text() + "data: {invalid}\n\n").await;
        assert!(matches!(
            run(&mock).await.0,
            Err(ModelError::StreamFailed {
                text_sent: true,
                ..
            })
        ));
    }
    #[tokio::test]
    async fn first_token_timeout_includes_wait_for_headers() {
        let mock = mock(200, vec![(0, end().into_bytes())], 300).await;
        let (tx, _rx) = mpsc::unbounded_channel();
        assert_eq!(
            client(&mock, 30, 1000).chat(&request(), &tx).await,
            Err(ModelError::Timeout)
        );
    }
    #[tokio::test]
    async fn heartbeat_does_not_reset_first_token_timeout() {
        let mock = mock(
            200,
            vec![
                (0, b": PROCESSING\n\n".to_vec()),
                (300, (text() + &end()).into_bytes()),
            ],
            0,
        )
        .await;
        let (tx, _rx) = mpsc::unbounded_channel();
        assert_eq!(
            client(&mock, 30, 1000).chat(&request(), &tx).await,
            Err(ModelError::Timeout)
        );
    }
    #[tokio::test]
    async fn first_token_timing_ignores_heartbeats() {
        let mock = mock(
            200,
            vec![
                (0, b": PROCESSING\n\n".to_vec()),
                (60, (text() + &end()).into_bytes()),
            ],
            0,
        )
        .await;
        let response = run(&mock).await.0.unwrap();
        assert!(response.time_to_first_token.unwrap() >= Duration::from_millis(60));
    }
    #[test]
    fn sse_buffer_preserves_multiline_data_and_split_unicode() {
        let mut buffer = SseBuffer::default();
        let mut events = vec![];
        for byte in b": comment\r\nevent: ignored\r\ndata: {\r\ndata: \"text\": \"Ch"
            .iter()
            .copied()
            .chain("ào\"}\r\n\r\n".bytes())
        {
            if let Some(event) = buffer.push(byte).unwrap() {
                events.push(event);
            }
        }
        assert_eq!(events, ["{\n\"text\": \"Chào\"}"]);
    }
    #[tokio::test]
    async fn whole_request_timeout_applies_after_first_delta() {
        let mock = mock(
            200,
            vec![(0, text().into_bytes()), (300, end().into_bytes())],
            0,
        )
        .await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let start = Instant::now();
        assert_eq!(
            client(&mock, 1000, 40).chat(&request(), &tx).await,
            Err(ModelError::Timeout)
        );
        assert_eq!(rx.try_recv().unwrap(), "Chào");
        assert!(start.elapsed() < Duration::from_millis(250));
    }
    #[tokio::test]
    async fn redirects_are_not_followed_or_retried() {
        let mut mock = canned(302, end()).await;
        assert!(matches!(
            run(&mock).await.0,
            Err(ModelError::Other {
                status: Some(302),
                ..
            })
        ));
        mock.requests.try_recv().unwrap();
        assert!(mock.requests.try_recv().is_err());
    }
    #[test]
    fn config_key_required_and_defaults() {
        assert!(config(&[]).unwrap().is_none());
        assert!(config(&[("OPENROUTER_API_KEY", " ")]).unwrap().is_none());
        let c = config(&[("OPENROUTER_API_KEY", "test")]).unwrap().unwrap();
        assert_eq!(c.url, "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(c.first_token_timeout, Duration::from_secs(20));
        assert_eq!(c.timeout, Duration::from_secs(60));
    }
    #[test]
    fn config_url_and_timeouts_are_validated() {
        for url in [
            "bad",
            "ftp://example.com/chat",
            "https://user:secret@example.com/chat",
            "https://example.com/chat#fragment",
        ] {
            assert!(
                config(&[
                    ("OPENROUTER_API_KEY", "test"),
                    ("ASSISTANT_OPENROUTER_URL", url)
                ])
                .is_err(),
                "{url}"
            );
        }
        for name in [
            "ASSISTANT_FIRST_TOKEN_TIMEOUT_MS",
            "ASSISTANT_MODEL_TIMEOUT_MS",
        ] {
            for value in ["0", "-1", "bad"] {
                assert!(config(&[("OPENROUTER_API_KEY", "test"), (name, value)]).is_err());
            }
        }
        let c = config(&[
            ("OPENROUTER_API_KEY", "test"),
            ("ASSISTANT_OPENROUTER_URL", "http://127.0.0.1:1234/chat"),
            ("ASSISTANT_FIRST_TOKEN_TIMEOUT_MS", "12"),
            ("ASSISTANT_MODEL_TIMEOUT_MS", "34"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(c.first_token_timeout, Duration::from_millis(12));
        assert_eq!(c.timeout, Duration::from_millis(34));
        assert_eq!(c.url, "http://127.0.0.1:1234/chat");
    }
}
