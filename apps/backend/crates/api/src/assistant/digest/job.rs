//! Morning digest generation, push delivery and periodic receipt reconciliation.
use super::{StoredDigest, active_store_ids, get_or_generate, stored};
use crate::{AppState, devices::Device, push, time};
use anyhow::{Context, ensure};
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde_json::json;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

pub use crate::push::ReceiptReport;

#[derive(Debug, Clone)]
pub struct DigestJobConfig {
    pub enabled: bool,
    pub send_at: NaiveTime,
    pub receipt_delay: Duration,
    pub active_window: chrono::Duration,
}
impl Default for DigestJobConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            send_at: NaiveTime::from_hms_opt(7, 0, 0).unwrap(),
            receipt_delay: Duration::from_secs(15 * 60),
            active_window: chrono::Duration::days(30),
        }
    }
}
impl DigestJobConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let mut config = Self::default();
        if let Some(value) = get("DIGEST_ENABLED") {
            config.enabled = !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false");
        }
        if let Some(value) = get("DIGEST_SEND_AT") {
            let value = value.trim();
            ensure!(
                value.len() == 5
                    && value.as_bytes()[2] == b':'
                    && value
                        .as_bytes()
                        .iter()
                        .enumerate()
                        .all(|(i, b)| i == 2 || b.is_ascii_digit()),
                "DIGEST_SEND_AT must be HH:MM"
            );
            config.send_at = NaiveTime::parse_from_str(value, "%H:%M")
                .context("DIGEST_SEND_AT must be HH:MM")?;
        }
        Ok(config)
    }
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }
}

fn send_on(date: NaiveDate, send_at: NaiveTime) -> DateTime<Utc> {
    date.and_time(send_at)
        .and_local_timezone(time::STORE_TZ)
        .single()
        .expect("store send time is unambiguous in Asia/Ho_Chi_Minh")
        .with_timezone(&Utc)
}

/// The next local send time, strictly after `now` (including at the exact send time).
pub fn next_run(now: DateTime<Utc>, send_at: NaiveTime) -> DateTime<Utc> {
    let today = time::business_date(now);
    let send = send_on(today, send_at);
    if send > now {
        send
    } else {
        send_on(today.succ_opt().expect("next business date"), send_at)
    }
}

/// Startup catch-up is due at or after today's local send time.
pub fn due_today(now: DateTime<Utc>, send_at: NaiveTime) -> Option<NaiveDate> {
    let today = time::business_date(now);
    (now >= send_on(today, send_at)).then_some(today)
}

pub fn message(digest: &StoredDigest, device: &Device) -> push::PushMessage {
    let summary = &digest.summary_vi;
    let sentence = summary
        .find(". ")
        .map_or(summary.as_str(), |i| &summary[..=i]);
    push::PushMessage {
        to: device.token.clone(),
        title: if device.language == "en" {
            "Morning summary"
        } else {
            "Tóm tắt sáng nay"
        }
        .into(),
        body: sentence.chars().take(140).collect(),
        data: json!({"url": "/digest?entry=push", "business_date": digest.business_date}),
        channel_id: "digest".into(),
        priority: "high".into(),
        sound: Some("default".into()),
    }
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct RunReport {
    pub stores: usize,
    /// Digests absent at the start of the store's pass and successfully generated.
    pub generated: usize,
    pub pushed_stores: usize,
    pub sent: usize,
    /// Rejected tickets plus store operations that failed before completing.
    pub failed: usize,
    pub unregistered: usize,
}

/// Run with the default active window; the scheduler uses its supplied configuration.
pub async fn run_once(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<RunReport> {
    run_once_with_config(state, now, &DigestJobConfig::default()).await
}

async fn run_once_with_config(
    state: &AppState,
    now: DateTime<Utc>,
    config: &DigestJobConfig,
) -> anyhow::Result<RunReport> {
    crate::telemetry::job("digest.run", 1, async {
        let db = state.postgres.as_ref().context("database unavailable")?;
        let business_date = time::business_date(now);
        let ids = active_store_ids(db, config.active_window).await;
        let mut report = RunReport { stores: ids.len(), ..RunReport::default() };
        for store_id in ids {
            let result: anyhow::Result<()> = async {
                let existed = stored(db, store_id, business_date).await?.is_some();
                let digest = get_or_generate(state, store_id, business_date).await?;
                if !existed { report.generated += 1; }
                if digest.pushed_at.is_some() { return Ok(()); }
                let Some(api) = state.push.as_deref() else { return Ok(()); };
                // Claim before sending, even with zero devices. Other processes and
                // restarted workers must not send the same store/date again.
                let claimed = sqlx::query("UPDATE assistant_digests SET pushed_at=now() WHERE store_id=$1 AND business_date=$2 AND pushed_at IS NULL")
                    .bind(store_id).bind(business_date).execute(db).await?.rows_affected();
                if claimed == 0 { return Ok(()); }
                report.pushed_stores += 1;
                let sent = push::send_to_devices(db, api, store_id, business_date, |device| message(&digest, device)).await?;
                report.sent += sent.sent;
                report.failed += sent.failed;
                report.unregistered += sent.unregistered;
                Ok(())
            }.await;
            if let Err(error) = result {
                report.failed += 1;
                crate::error::log_anyhow_error!(error, &error, %store_id, "digest store pass failed");
            }
        }
        tracing::info!(stores = report.stores, generated = report.generated, pushed_stores = report.pushed_stores,
            sent = report.sent, failed = report.failed, unregistered = report.unregistered, "digest run completed");
        Ok(report)
    }).await
}

/// Reconcile receipts with the default delay; the scheduler honors its own delay.
pub async fn receipts_once(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<ReceiptReport> {
    receipts_once_with_config(state, now, &DigestJobConfig::default()).await
}

async fn receipts_once_with_config(
    state: &AppState,
    now: DateTime<Utc>,
    config: &DigestJobConfig,
) -> anyhow::Result<ReceiptReport> {
    let Some(api) = state.push.as_deref() else {
        return Ok(ReceiptReport::default());
    };
    let db = state.postgres.as_ref().context("database unavailable")?;
    push::check_receipts(db, api, config.receipt_delay, now).await
}

async fn send_pass(state: &AppState, config: &DigestJobConfig, now: DateTime<Utc>) {
    if let Err(error) = run_once_with_config(state, now, config).await {
        crate::error::log_anyhow_error!(error, &error, "digest run failed");
    }
}
async fn receipt_pass(state: &AppState, config: &DigestJobConfig) {
    if let Err(error) = receipts_once_with_config(state, Utc::now(), config).await {
        crate::error::log_anyhow_error!(error, &error, "digest receipt pass failed");
    }
}

pub fn spawn(
    state: AppState,
    config: DigestJobConfig,
    mut shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if !config.enabled {
            return;
        }
        tokio::select! {
            biased;
            _ = async {
                loop {
                    if *shutdown.borrow_and_update() || shutdown.changed().await.is_err() { break; }
                }
            } => {},
            _ = async {
                let now = Utc::now();
                let mut next_send = next_run(now, config.send_at);
                if due_today(now, config.send_at).is_some() {
                    send_pass(&state, &config, now).await;
                }
                // Also reconcile yesterday's pending tickets when starting before send time.
                receipt_pass(&state, &config).await;
                // Public configurations may request an immediate receipt pass; avoid a busy loop.
                let interval = config.receipt_delay.max(Duration::from_millis(1));
                let mut next_receipt = tokio::time::Instant::now() + interval;
                let mut sent_receipts: Option<tokio::time::Instant> = None;
                loop {
                    let until_send = (next_send - Utc::now()).to_std().unwrap_or_default();
                    let receipt_deadline = sent_receipts.map_or(next_receipt, |at| at.min(next_receipt));
                    let until_receipt = receipt_deadline.saturating_duration_since(tokio::time::Instant::now());
                    tokio::time::sleep(until_send.min(until_receipt)).await;
                    let now = Utc::now();
                    if now >= next_send {
                        send_pass(&state, &config, now).await;
                        next_send = next_run(Utc::now(), config.send_at);
                        // Keep a send-relative pass as well: a periodic pass just
                        // before tickets mature must not defer them another 15 minutes.
                        sent_receipts = Some(tokio::time::Instant::now() + interval);
                    }
                    let receipt_now = tokio::time::Instant::now();
                    let sent_due = sent_receipts.is_some_and(|at| receipt_now >= at);
                    if receipt_now >= next_receipt || sent_due {
                        receipt_pass(&state, &config).await;
                        next_receipt = tokio::time::Instant::now() + interval;
                        if sent_due { sent_receipts = None; }
                    }
                }
            } => {},
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::Device;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn config_defaults_and_overrides() {
        let config = DigestJobConfig::from_lookup(|_| None).unwrap();
        assert!(config.enabled);
        assert_eq!(config.send_at, NaiveTime::from_hms_opt(7, 0, 0).unwrap());
        assert_eq!(config.receipt_delay, Duration::from_secs(15 * 60));
        assert_eq!(config.active_window, chrono::Duration::days(30));
        for value in ["0", "false", "FALSE"] {
            let config = DigestJobConfig::from_lookup(|key| match key {
                "DIGEST_ENABLED" => Some(value.into()),
                "DIGEST_SEND_AT" => Some("23:45".into()),
                _ => None,
            })
            .unwrap();
            assert!(!config.enabled);
            assert_eq!(config.send_at, NaiveTime::from_hms_opt(23, 45, 0).unwrap());
        }
        for value in ["25:00", "07:60", "7:00", "07:00:00", "bad", ""] {
            assert!(
                DigestJobConfig::from_lookup(|key| (key == "DIGEST_SEND_AT").then(|| value.into()))
                    .is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn next_send_and_catch_up_follow_business_date_boundaries() {
        for (now, send_at, next, due) in [
            (
                "2026-10-25T23:59:59Z",
                "07:00",
                "2026-10-26T00:00:00Z",
                None,
            ),
            (
                "2026-10-26T00:00:00Z",
                "07:00",
                "2026-10-27T00:00:00Z",
                Some("2026-10-26"),
            ),
            (
                "2026-10-26T00:00:01Z",
                "07:00",
                "2026-10-27T00:00:00Z",
                Some("2026-10-26"),
            ),
            (
                "2026-12-31T16:59:59Z",
                "07:00",
                "2027-01-01T00:00:00Z",
                Some("2026-12-31"),
            ),
            (
                "2026-12-31T17:00:00Z",
                "07:00",
                "2027-01-01T00:00:00Z",
                None,
            ),
            (
                "2026-10-26T01:30:00Z",
                "08:30",
                "2026-10-27T01:30:00Z",
                Some("2026-10-26"),
            ),
            (
                "2026-06-30T16:59:59Z",
                "00:00",
                "2026-06-30T17:00:00Z",
                Some("2026-06-30"),
            ),
        ] {
            let now = now.parse().unwrap();
            let send_at = NaiveTime::parse_from_str(send_at, "%H:%M").unwrap();
            assert_eq!(
                next_run(now, send_at),
                next.parse::<DateTime<Utc>>().unwrap()
            );
            assert_eq!(
                due_today(now, send_at),
                due.map(|d| d.parse::<NaiveDate>().unwrap())
            );
        }
    }

    fn fixtures(summary: &str, language: &str) -> (StoredDigest, Device) {
        let now = "2026-10-26T00:00:00Z".parse().unwrap();
        let store_id = Uuid::new_v4();
        (
            StoredDigest {
                store_id,
                business_date: "2026-10-26".parse().unwrap(),
                generated_at: now,
                source: "template".into(),
                model: None,
                summary_vi: summary.into(),
                payload: json!({}),
                pushed_at: None,
            },
            Device {
                token: "ExponentPushToken[test]".into(),
                store_id,
                member_id: Uuid::new_v4(),
                platform: "android".into(),
                app_version: "1.0".into(),
                language: language.into(),
                created_at: now,
                updated_at: now,
            },
        )
    }

    #[test]
    fn message_uses_first_sentence_and_digest_navigation() {
        for (language, title) in [("vi", "Tóm tắt sáng nay"), ("en", "Morning summary")] {
            let (digest, device) = fixtures("Hôm qua bán tốt. Hãy nhập thêm sữa.", language);
            let payload = serde_json::to_value(message(&digest, &device)).unwrap();
            assert_eq!(
                payload,
                json!({
                    "to": device.token, "title": title, "body": "Hôm qua bán tốt.",
                    "data": {"url": "/digest?entry=push", "business_date": "2026-10-26"},
                    "channelId": "digest", "priority": "high", "sound": "default"
                })
            );
        }
        let (digest, device) = fixtures(&"ế".repeat(150), "vi");
        assert_eq!(message(&digest, &device).body, "ế".repeat(140));
        let (digest, device) = fixtures("Không có dấu chấm", "vi");
        assert_eq!(message(&digest, &device).body, "Không có dấu chấm");
    }

    #[tokio::test]
    async fn shutdown_stops_without_waiting_for_database_or_daily_tick() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(30))
            .connect_lazy("postgres://unused:unused@localhost:1/unused")
            .unwrap();
        let state = AppState {
            postgres: Some(pool),
            ..AppState::default()
        };
        for send_at in [NaiveTime::MIN, NaiveTime::from_hms_opt(23, 59, 59).unwrap()] {
            for initially_stopped in [true, false] {
                let (send, receive) = watch::channel(initially_stopped);
                let config = DigestJobConfig {
                    send_at,
                    ..DigestJobConfig::default()
                };
                let task = spawn(state.clone(), config, receive);
                tokio::task::yield_now().await;
                if !initially_stopped {
                    send.send(true).unwrap();
                }
                tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .expect("digest job must stop promptly")
                    .unwrap();
            }
        }
    }
}
