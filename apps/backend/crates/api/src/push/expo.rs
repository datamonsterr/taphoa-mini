use super::{PushApi, PushMessage, Receipt, Ticket};
use anyhow::{Context, bail, ensure};
use async_trait::async_trait;
use reqwest::{
    Client, StatusCode,
    header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};

const DEFAULT_URL: &str = "https://exp.host/--/api/v2/push";

#[derive(Clone)]
pub struct PushConfig {
    pub url: String,
    pub access_token: Option<String>,
    /// Delays before attempts two and three are base and 4 * base.
    pub backoff_base: Duration,
}
impl PushConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let get = |key| {
            get(key)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let config = Self {
            url: get("EXPO_PUSH_URL")
                .unwrap_or_else(|| DEFAULT_URL.into())
                .trim_end_matches('/')
                .to_owned(),
            access_token: get("EXPO_ACCESS_TOKEN"),
            backoff_base: Duration::from_secs(1),
        };
        config.validate()?;
        Ok(config)
    }
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }
    fn validate(&self) -> anyhow::Result<()> {
        let url = reqwest::Url::parse(&self.url)
            .ok()
            .context("EXPO_PUSH_URL must be an HTTP(S) URL")?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "EXPO_PUSH_URL must be an HTTP(S) URL without credentials, query or fragment"
        );
        ensure!(
            self.backoff_base.checked_mul(4).is_some(),
            "push backoff is too large"
        );
        Ok(())
    }
}

pub struct ExpoPush {
    client: Client,
    config: PushConfig,
    address: String,
}
impl ExpoPush {
    pub fn new(config: PushConfig) -> anyhow::Result<Self> {
        config.validate()?;
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(token) = &config.access_token {
            let mut header = HeaderValue::from_str(&format!("Bearer {token}"))
                .ok()
                .context("invalid EXPO_ACCESS_TOKEN header")?;
            header.set_sensitive(true);
            headers.insert(AUTHORIZATION, header);
        }
        let client = Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .ok()
            .context("could not build Expo HTTP client")?;
        let address = crate::telemetry::server_address(&config.url);
        Ok(Self {
            client,
            config,
            address,
        })
    }
    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> anyhow::Result<T> {
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(self.config.backoff_base * if attempt == 1 { 1 } else { 4 })
                    .await;
            }
            let response = match self
                .client
                .post(format!("{}/{path}", self.config.url))
                .json(body)
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) if (error.is_connect() || error.is_timeout()) && attempt < 2 => {
                    continue;
                }
                Err(_) => bail!("Expo transport failed"),
            };
            let status = response.status();
            if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempt < 2
            {
                continue;
            }
            let payload: Value = response
                .json()
                .await
                .ok()
                .context("invalid Expo response JSON")?;
            if !status.is_success()
                || payload
                    .get("errors")
                    .and_then(Value::as_array)
                    .is_some_and(|errors| !errors.is_empty())
            {
                // Expo messages can echo tokens. Propagate only the machine-readable code.
                let code = payload
                    .pointer("/errors/0/code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                bail!("Expo HTTP {}: {}", status.as_u16(), code);
            }
            return serde_json::from_value(
                payload
                    .get("data")
                    .cloned()
                    .context("missing Expo response data")?,
            )
            .ok()
            .context("invalid Expo response data");
        }
        unreachable!("each final attempt returns")
    }
}
#[async_trait]
impl PushApi for ExpoPush {
    async fn send(&self, messages: &[PushMessage]) -> anyhow::Result<Vec<Ticket>> {
        crate::telemetry::client("expo.send", self.server_address(), async {
            let mut tickets = Vec::with_capacity(messages.len());
            for batch in messages.chunks(100) {
                let response: Vec<Ticket> = self.post("send", &batch).await?;
                super::validate_tickets(&response, batch.len())?;
                tickets.extend(response);
            }
            Ok(tickets)
        })
        .await
    }
    async fn receipts(&self, ids: &[String]) -> anyhow::Result<HashMap<String, Receipt>> {
        crate::telemetry::client("expo.receipts", self.server_address(), async {
            let mut receipts = HashMap::new();
            for batch in ids.chunks(1000) {
                let response: HashMap<String, Receipt> =
                    self.post("getReceipts", &json!({"ids":batch})).await?;
                receipts.extend(response);
            }
            Ok(receipts)
        })
        .await
    }
    fn server_address(&self) -> &str {
        &self.address
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn push_config_parses_defaults_overrides_and_empty_values() {
        let defaults = PushConfig::from_lookup(|_| None).unwrap();
        assert_eq!(defaults.url, "https://exp.host/--/api/v2/push");
        assert!(defaults.access_token.is_none());
        assert!(!defaults.backoff_base.is_zero());
        let empty = PushConfig::from_lookup(|_| Some("  ".into())).unwrap();
        assert_eq!(empty.url, defaults.url);
        assert!(empty.access_token.is_none());
        let override_config = PushConfig::from_lookup(|key| match key {
            "EXPO_PUSH_URL" => Some("http://localhost:1234/push/".into()),
            "EXPO_ACCESS_TOKEN" => Some("test-key".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(override_config.url, "http://localhost:1234/push");
        assert_eq!(override_config.access_token.as_deref(), Some("test-key"));
        for url in [
            "not a url",
            "ftp://localhost/push",
            "https://user:password@example.com/push",
            "https://example.com/push?secret=x",
        ] {
            assert!(
                PushConfig::from_lookup(|key| (key == "EXPO_PUSH_URL").then(|| url.into()))
                    .is_err()
            );
        }
    }
}
