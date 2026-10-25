use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecisionRequest {
    pub model: String,
    pub state: serde_json::Value,
    pub questions: BTreeMap<String, Question>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Question {
    Choice {
        instructions: String,
        criteria: BTreeMap<String, String>,
    },
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DecisionResponse {
    #[serde(default)]
    pub model: String,
    pub answers: BTreeMap<String, Answer>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Answer {
    Choice {
        #[serde(default)]
        choice: Option<String>,
        #[serde(default)]
        probabilities: BTreeMap<String, f32>,
        #[serde(default)]
        confidence: Option<f32>,
    },
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, thiserror::Error, PartialEq)]
pub enum DecisionError {
    #[error("decisions request timed out")]
    Timeout,
    #[error("decisions transport failed")]
    Transport,
    #[error("decisions returned HTTP {0}")]
    Http(u16),
    #[error("invalid decisions response")]
    InvalidResponse,
    #[error("invalid decisions configuration: {0}")]
    Config(&'static str),
}
#[async_trait]
pub trait DecisionClient: Send + Sync {
    async fn decide(&self, req: &DecisionRequest) -> Result<DecisionResponse, DecisionError>;
    fn model(&self) -> &str;
}
// Intentionally no Debug: configuration contains an API key.
#[derive(Clone)]
pub struct DecisionsConfig {
    pub api_key: String,
    pub url: String,
    pub model: String,
    pub timeout: Duration,
}
impl DecisionsConfig {
    pub fn from_lookup(
        get: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, DecisionError> {
        let Some(api_key) = get("OPENROUTER_API_KEY").filter(|key| !key.trim().is_empty()) else {
            return Ok(None);
        };
        let timeout_ms = get("DECISIONS_TIMEOUT_MS")
            .unwrap_or_else(|| "2500".into())
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or(DecisionError::Config(
                "DECISIONS_TIMEOUT_MS must be a positive integer",
            ))?;
        let model =
            get("DECISIONS_MODEL").unwrap_or_else(|| "inception/mercury-decide:free".into());
        if model.trim().is_empty() {
            return Err(DecisionError::Config("DECISIONS_MODEL"));
        }
        Ok(Some(Self {
            api_key,
            url: get("DECISIONS_URL")
                .unwrap_or_else(|| "https://openrouter.ai/api/alpha/decisions".into()),
            model,
            timeout: Duration::from_millis(timeout_ms),
        }))
    }
    pub fn from_env() -> Result<Option<Self>, DecisionError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}
/// One HTTP call per decision; both redirects and automatic retries are disabled.
pub struct OpenRouterDecisions {
    client: reqwest::Client,
    url: reqwest::Url,
    model: String,
}
impl OpenRouterDecisions {
    pub fn new(config: DecisionsConfig) -> Result<Self, DecisionError> {
        use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
        if config.api_key.trim().is_empty()
            || config.timeout.is_zero()
            || config.model.trim().is_empty()
        {
            return Err(DecisionError::Config(
                "key, model and positive timeout are required",
            ));
        }
        let url =
            reqwest::Url::parse(&config.url).map_err(|_| DecisionError::Config("DECISIONS_URL"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(DecisionError::Config("DECISIONS_URL"));
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|_| DecisionError::Config("OPENROUTER_API_KEY"))?;
        authorization.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-title", HeaderValue::from_static("taphoa-mini"));
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(config.timeout)
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| DecisionError::Transport)?;
        Ok(Self {
            client,
            url,
            model: config.model,
        })
    }
}
#[async_trait]
impl DecisionClient for OpenRouterDecisions {
    async fn decide(&self, req: &DecisionRequest) -> Result<DecisionResponse, DecisionError> {
        crate::telemetry::client(
            "openrouter decisions",
            self.url.host_str().unwrap_or("unknown"),
            async {
                let response = self
                    .client
                    .post(self.url.clone())
                    .json(req)
                    .send()
                    .await
                    .map_err(|error| {
                        if error.is_timeout() {
                            DecisionError::Timeout
                        } else {
                            DecisionError::Transport
                        }
                    })?;
                if !response.status().is_success() {
                    return Err(DecisionError::Http(response.status().as_u16()));
                }
                response.json().await.map_err(|error| {
                    if error.is_timeout() {
                        DecisionError::Timeout
                    } else {
                        DecisionError::InvalidResponse
                    }
                })
            },
        )
        .await
    }
    fn model(&self) -> &str {
        &self.model
    }
}

/// Thread-safe scripted client. Exhausting the script returns a transport error.
pub struct FakeDecisions {
    model: String,
    answers: std::sync::Mutex<std::collections::VecDeque<Result<DecisionResponse, DecisionError>>>,
    requests: std::sync::Mutex<Vec<DecisionRequest>>,
}
impl FakeDecisions {
    pub fn new(
        model: impl Into<String>,
        answers: impl IntoIterator<Item = Result<DecisionResponse, DecisionError>>,
    ) -> Self {
        Self {
            model: model.into(),
            answers: std::sync::Mutex::new(answers.into_iter().collect()),
            requests: std::sync::Mutex::new(Vec::new()),
        }
    }
    pub fn requests(&self) -> Vec<DecisionRequest> {
        self.requests
            .lock()
            .expect("fake requests lock poisoned")
            .clone()
    }
}
#[async_trait]
impl DecisionClient for FakeDecisions {
    async fn decide(&self, req: &DecisionRequest) -> Result<DecisionResponse, DecisionError> {
        self.requests
            .lock()
            .map_err(|_| DecisionError::Transport)?
            .push(req.clone());
        self.answers
            .lock()
            .map_err(|_| DecisionError::Transport)?
            .pop_front()
            .unwrap_or(Err(DecisionError::Transport))
    }
    fn model(&self) -> &str {
        &self.model
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::StatusCode, routing::post};
    use serde_json::json;

    fn request() -> DecisionRequest {
        DecisionRequest {
            model: "configured/model".into(),
            state: json!({"line": "Coca-Cola 24 204.000"}),
            questions: BTreeMap::new(),
        }
    }
    fn config(url: String, timeout: u64) -> DecisionsConfig {
        DecisionsConfig {
            api_key: "test-secret".into(),
            url,
            model: "configured/model".into(),
            timeout: Duration::from_millis(timeout),
        }
    }
    async fn server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/decisions", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (url, task)
    }
    #[test]
    fn config_defaults_and_overrides_and_secrets() {
        assert!(DecisionsConfig::from_lookup(|_| None).unwrap().is_none());
        assert!(
            DecisionsConfig::from_lookup(|_| Some(" ".into()))
                .unwrap()
                .is_none()
        );
        let default = DecisionsConfig::from_lookup(|key| {
            (key == "OPENROUTER_API_KEY").then(|| "secret".into())
        })
        .unwrap()
        .unwrap();
        assert_eq!(default.model, "inception/mercury-decide:free");
        assert_eq!(default.url, "https://openrouter.ai/api/alpha/decisions");
        assert_eq!(default.timeout, Duration::from_millis(2500));
        for timeout in ["0", "bad", "-1"] {
            let error = DecisionsConfig::from_lookup(|key| {
                Some(
                    if key == "DECISIONS_TIMEOUT_MS" {
                        timeout
                    } else {
                        "secret"
                    }
                    .into(),
                )
            })
            .err()
            .unwrap();
            assert!(!error.to_string().contains("secret"));
        }
        let custom = DecisionsConfig::from_lookup(|key| match key {
            "OPENROUTER_API_KEY" => Some("secret".into()),
            "DECISIONS_MODEL" => Some("~typesafe/jev-latest".into()),
            "DECISIONS_URL" => Some("http://localhost/decide".into()),
            "DECISIONS_TIMEOUT_MS" => Some("50".into()),
            _ => None,
        })
        .unwrap()
        .unwrap();
        assert_eq!(custom.model, "~typesafe/jev-latest");
        assert_eq!(custom.timeout, Duration::from_millis(50));
        assert_eq!(custom.url, "http://localhost/decide");
    }
    #[test]
    fn tolerant_answers() {
        let response: DecisionResponse = serde_json::from_value(json!({"answers": {"a": {"type":"choice", "choice":"item"}, "b":{"type":"future", "unknown":42}}})).unwrap();
        assert!(
            matches!(&response.answers["a"], Answer::Choice { confidence: None, probabilities, .. } if probabilities.is_empty())
        );
        assert_eq!(response.answers["b"], Answer::Unknown);
    }
    #[tokio::test]
    async fn http_success_headers_body_and_sample_response() {
        let (url, task) = server(Router::new().route("/decisions", post(|headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| async move {
            assert_eq!(headers["authorization"], "Bearer test-secret");
            assert_eq!(headers["content-type"], "application/json");
            assert_eq!(headers["x-title"], "taphoa-mini");
            assert_eq!(body, serde_json::to_value(request()).unwrap());
            Json(json!({"answers":{"role_0":{"type":"choice","choice":"item","probabilities":{"item":0.999},"confidence":0.999}}}))
        }))).await;
        let client = OpenRouterDecisions::new(config(url, 1000)).unwrap();
        assert_eq!(client.model(), "configured/model");
        let response = client.decide(&request()).await.unwrap();
        assert!(
            matches!(&response.answers["role_0"], Answer::Choice { choice: Some(choice), confidence: Some(c), .. } if choice == "item" && *c == 0.999)
        );
        task.abort();
    }
    #[tokio::test]
    async fn timeout_and_http_500_fall_back() {
        for delay in [true, false] {
            let (url, task) = server(Router::new().route(
                "/decisions",
                post(move || async move {
                    if delay {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "do not expose upstream body",
                    )
                }),
            ))
            .await;
            let client = OpenRouterDecisions::new(config(url, 50)).unwrap();
            assert_eq!(
                client.decide(&request()).await.unwrap_err(),
                if delay {
                    DecisionError::Timeout
                } else {
                    DecisionError::Http(500)
                }
            );
            let candidates = crate::receipts::parse_lines(&[crate::receipts::OcrText {
                text: "Coca-Cola x24 204.000".into(),
                confidence: 1.,
                bbox: [0.; 4],
            }]);
            let outcome = crate::receipts::map_lines(Some(&client), &candidates, &[]).await;
            assert_eq!(outcome.parser, "fallback");
            assert_eq!(outcome.lines.len(), 1);
            task.abort();
        }
    }
    #[tokio::test]
    async fn invalid_json_is_an_error() {
        let (url, task) =
            server(Router::new().route("/decisions", post(|| async { "not json" }))).await;
        let client = OpenRouterDecisions::new(config(url, 1000)).unwrap();
        assert_eq!(
            client.decide(&request()).await.unwrap_err(),
            DecisionError::InvalidResponse
        );
        task.abort();
    }
    #[tokio::test]
    #[ignore = "requires OPENROUTER_API_KEY; performs one live request"]
    async fn live_openrouter() {
        let Some(config) = DecisionsConfig::from_env().unwrap() else {
            eprintln!("OPENROUTER_API_KEY absent; skipped");
            return;
        };
        let client = OpenRouterDecisions::new(config).unwrap();
        let candidates = crate::receipts::parse_lines(&[crate::receipts::OcrText {
            text: "Coca-Cola lon 330ml 24 8.500 204.000".into(),
            confidence: 1.,
            bbox: [0.; 4],
        }]);
        let catalog = vec![vec![crate::receipts::CatalogCandidate {
            product_id: uuid::Uuid::nil(),
            name: "Coca-Cola lon 330ml".into(),
            price: 8500,
            similarity: 1.,
        }]];
        let start = std::time::Instant::now();
        let response = client
            .decide(&crate::receipts::build_request(
                client.model(),
                &candidates,
                &catalog,
            ))
            .await
            .unwrap();
        eprintln!(
            "OpenRouter Decisions latency: {} ms",
            start.elapsed().as_millis()
        );
        assert!(
            matches!(&response.answers["role_0"], Answer::Choice { choice: Some(choice), .. } if choice == "item")
        );
        assert!(
            matches!(&response.answers["match_0"], Answer::Choice { choice: Some(choice), .. } if choice == "p0")
        );
    }
}
