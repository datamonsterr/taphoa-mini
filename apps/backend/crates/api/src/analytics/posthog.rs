//! Bounded, best-effort PostHog transport. Captures never wait for HTTP or queue space.
use super::{Analytics, CaptureEvent};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
};

const CAPACITY: usize = 1000;
const BATCH_SIZE: usize = 100;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);

// Do not derive Debug: the project token is a credential.
pub struct PostHogConfig {
    pub token: String,
    pub host: String,
    pub environment: String,
    pub version: String,
}
impl PostHogConfig {
    pub fn from_env() -> Option<Self> {
        Self::from_lookup(
            |key| std::env::var(key).ok(),
            crate::telemetry::TelemetryConfig::from_env(),
        )
    }
    fn from_lookup(
        get: impl Fn(&str) -> Option<String>,
        telemetry: crate::telemetry::TelemetryConfig,
    ) -> Option<Self> {
        let token = get("POSTHOG_PROJECT_TOKEN").filter(|token| !token.trim().is_empty())?;
        Some(Self {
            token,
            host: get("POSTHOG_HOST")
                .filter(|host| !host.trim().is_empty())
                .unwrap_or_else(|| "https://us.i.posthog.com".into()),
            environment: telemetry.environment,
            version: telemetry.version,
        })
    }
}

pub struct PostHogAnalytics {
    sender: mpsc::Sender<CaptureEvent>,
    stop: watch::Sender<bool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    overflow: Arc<AtomicBool>,
}
impl PostHogAnalytics {
    pub fn new(config: PostHogConfig) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let (stop, shutdown) = watch::channel(false);
        let overflow = Arc::new(AtomicBool::new(false));
        let worker = tokio::spawn(run(config, receiver, shutdown, overflow.clone()));
        Self {
            sender,
            stop,
            worker: Mutex::new(Some(worker)),
            overflow,
        }
    }
    /// Stop accepting captures and drain queued batches, abandoning a stuck exporter after 5 s.
    pub async fn shutdown(&self) {
        let _ = self.stop.send(true);
        if let Some(mut task) = self.worker.lock().await.take()
            && tokio::time::timeout(Duration::from_secs(5), &mut task)
                .await
                .is_err()
        {
            task.abort();
            let _ = task.await;
            tracing::warn!("posthog shutdown timed out; queued analytics dropped");
        }
    }
}
#[async_trait]
impl Analytics for PostHogAnalytics {
    async fn capture_event(&self, mut event: CaptureEvent) -> anyhow::Result<()> {
        // Freeze capture time before queueing so retries retain identical timestamps.
        if event.timestamp.is_none() {
            event.timestamp = event
                .properties
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.to_utc())
                .or_else(|| Some(chrono::Utc::now()));
        }
        if self.sender.try_send(event).is_err() && !self.overflow.swap(true, Ordering::Relaxed) {
            tracing::warn!("posthog queue unavailable; analytics dropped");
        }
        Ok(())
    }
}
fn wire_event(mut event: CaptureEvent, config: &PostHogConfig) -> Value {
    event
        .properties
        .insert("$groups".into(), json!(event.groups));
    event
        .properties
        .entry("environment")
        .or_insert_with(|| json!(config.environment));
    event
        .properties
        .insert("app_version".into(), json!(config.version));
    event
        .properties
        .insert("$lib".into(), json!("taphoa-backend"));
    let mut value =
        json!({"event":event.event,"distinct_id":event.distinct_id,"properties":event.properties});
    if let Some(timestamp) = event.timestamp {
        value["timestamp"] = json!(timestamp.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true));
    }
    if let Some(uuid) = event.uuid {
        value["uuid"] = json!(uuid);
    }
    value
}
async fn run(
    config: PostHogConfig,
    mut receiver: mpsc::Receiver<CaptureEvent>,
    mut shutdown: watch::Receiver<bool>,
    overflow: Arc<AtomicBool>,
) {
    let Ok(client) = reqwest::Client::builder()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        tracing::warn!("posthog HTTP client initialization failed");
        return;
    };
    let mut tick =
        tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_INTERVAL, FLUSH_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => { receiver.close(); break; }
            event = receiver.recv() => match event {
                Some(event) => batch.push(wire_event(event, &config)),
                None => break,
            },
            _ = tick.tick() => {
                flush(&client, &config, &mut batch, &overflow).await;
            }
        }
        if batch.len() == BATCH_SIZE {
            flush(&client, &config, &mut batch, &overflow).await;
        }
    }
    while let Some(event) = receiver.recv().await {
        batch.push(wire_event(event, &config));
        if batch.len() == BATCH_SIZE {
            flush(&client, &config, &mut batch, &overflow).await;
        }
    }
    flush(&client, &config, &mut batch, &overflow).await;
}
async fn flush(
    client: &reqwest::Client,
    config: &PostHogConfig,
    batch: &mut Vec<Value>,
    overflow: &AtomicBool,
) {
    if batch.is_empty() {
        return;
    }
    let body = json!({"api_key":config.token,"batch":batch});
    let url = format!("{}/batch/", config.host.trim_end_matches('/'));
    let address = crate::telemetry::server_address(&config.host);
    let mut sent = false;
    for delay in [
        Duration::ZERO,
        Duration::from_millis(500),
        Duration::from_secs(2),
        Duration::from_secs(5),
    ] {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let result = crate::telemetry::client("posthog batch", &address, async {
            client
                .post(&url)
                .timeout(Duration::from_secs(2))
                .json(&body)
                .send()
                .await?
                .error_for_status()
        })
        .await;
        if result.is_ok() {
            sent = true;
            break;
        }
    }
    if !sent {
        tracing::warn!(
            events = batch.len(),
            "posthog batch failed; analytics dropped"
        );
    }
    batch.clear();
    overflow.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_is_opt_in_and_uses_telemetry_defaults() {
        let telemetry = || crate::telemetry::TelemetryConfig::from_lookup(|_| None, || None);
        assert!(PostHogConfig::from_lookup(|_| None, telemetry()).is_none());
        assert!(PostHogConfig::from_lookup(|_| Some(" ".into()), telemetry()).is_none());
        let config = PostHogConfig::from_lookup(
            |key| (key == "POSTHOG_PROJECT_TOKEN").then(|| "test".into()),
            telemetry(),
        )
        .unwrap();
        assert_eq!(config.host, "https://us.i.posthog.com");
        assert_eq!(config.environment, "local");
    }
}
