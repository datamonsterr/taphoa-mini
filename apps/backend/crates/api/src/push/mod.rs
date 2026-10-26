//! Expo delivery and receipt reconciliation. Payloads and tokens never enter logs.
pub mod expo;
pub use expo::{ExpoPush, PushConfig};

use crate::devices::Device;
use anyhow::{Context, ensure};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::PgPool;
use std::{collections::HashMap, time::Duration};
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushMessage {
    pub to: String,
    pub title: String,
    pub body: String,
    pub data: serde_json::Value,
    pub channel_id: String,
    pub priority: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Ticket {
    pub status: String,
    pub id: Option<String>,
    pub message: Option<String>,
    #[serde(default, rename = "details", deserialize_with = "details_error")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Receipt {
    pub status: String,
    pub message: Option<String>,
    #[serde(default, rename = "details", deserialize_with = "details_error")]
    pub error: Option<String>,
}
fn details_error<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    struct Details {
        error: Option<String>,
    }
    Ok(Option::<Details>::deserialize(deserializer)?.and_then(|details| details.error))
}

#[async_trait]
pub trait PushApi: Send + Sync {
    async fn send(&self, messages: &[PushMessage]) -> anyhow::Result<Vec<Ticket>>;
    async fn receipts(&self, ids: &[String]) -> anyhow::Result<HashMap<String, Receipt>>;
    fn server_address(&self) -> &str;
}
fn validate_tickets(tickets: &[Ticket], expected: usize) -> anyhow::Result<()> {
    ensure!(
        tickets.len() == expected,
        "Expo ticket count does not match messages"
    );
    ensure!(
        tickets.iter().all(|ticket| match ticket.status.as_str() {
            "ok" => ticket.id.as_ref().is_some_and(|id| !id.is_empty()),
            "error" => true,
            _ => false,
        }),
        "invalid Expo ticket"
    );
    Ok(())
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct SendReport {
    /// Messages accepted by Expo, awaiting a receipt.
    pub sent: usize,
    pub failed: usize,
    pub unregistered: usize,
}
pub async fn send_to_devices(
    pool: &PgPool,
    api: &dyn PushApi,
    store_id: Uuid,
    business_date: NaiveDate,
    build: impl Fn(&Device) -> PushMessage,
) -> anyhow::Result<SendReport> {
    crate::telemetry::job("push.send", 1, async {
        let devices: Vec<Device> = sqlx::query_as("SELECT * FROM devices WHERE store_id=$1 ORDER BY token")
            .bind(store_id).fetch_all(pool).await?;
        let mut report = SendReport::default();
        for batch in devices.chunks(100) {
            let messages: Vec<_> = batch.iter().map(&build).collect();
            let tickets = api.send(&messages).await?;
            validate_tickets(&tickets, batch.len())?;
            let mut tx = pool.begin().await?;
            for (device, ticket) in batch.iter().zip(tickets) {
                let accepted = ticket.status == "ok";
                sqlx::query("INSERT INTO push_tickets(store_id,token,business_date,ticket_id,status,error_code) VALUES ($1,$2,$3,$4,$5,$6)")
                    .bind(store_id).bind(&device.token).bind(business_date)
                    .bind(if accepted { ticket.id.as_deref() } else { None })
                    .bind(if accepted { "pending_receipt" } else { "error" })
                    .bind(if accepted { None } else { ticket.error.as_deref() })
                    .execute(&mut *tx).await?;
                if accepted { report.sent += 1; } else { report.failed += 1; }
                if !accepted && ticket.error.as_deref() == Some("DeviceNotRegistered") {
                    let removed = sqlx::query("DELETE FROM devices WHERE token=$1 AND store_id=$2")
                        .bind(&device.token).bind(store_id).execute(&mut *tx).await?.rows_affected();
                    report.unregistered += removed as usize;
                }
            }
            tx.commit().await?;
        }
        tracing::info!(sent = report.sent, failed = report.failed, unregistered = report.unregistered, "push send completed");
        Ok(report)
    }).await
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct ReceiptReport {
    pub ok: usize,
    /// Explicit error receipts; missing receipts are counted separately.
    pub errors: usize,
    pub unregistered: usize,
    pub missing: usize,
}
#[derive(sqlx::FromRow)]
struct Pending {
    id: Uuid,
    store_id: Uuid,
    token: String,
    ticket_id: Option<String>,
    created_at: DateTime<Utc>,
}
pub async fn check_receipts(
    pool: &PgPool,
    api: &dyn PushApi,
    min_age: Duration,
    now: DateTime<Utc>,
) -> anyhow::Result<ReceiptReport> {
    crate::telemetry::job("push.receipts", 1, async {
        let age = chrono::Duration::from_std(min_age).ok().context("receipt min_age is too large")?;
        let cutoff = now.checked_sub_signed(age).context("receipt min_age is too large")?;
        let expires = now.checked_sub_signed(chrono::Duration::hours(24)).context("receipt clock out of range")?;
        let pending: Vec<Pending> = sqlx::query_as("SELECT id,store_id,token,ticket_id,created_at FROM push_tickets WHERE status='pending_receipt' AND created_at <= $1 ORDER BY created_at,id")
            .bind(cutoff).fetch_all(pool).await?;
        let mut report = ReceiptReport::default();
        for batch in pending.chunks(1000) {
            let ids: Vec<_> = batch.iter().filter_map(|row| row.ticket_id.clone()).collect();
            let receipts = if ids.is_empty() { HashMap::new() } else { api.receipts(&ids).await? };
            let mut tx = pool.begin().await?;
            for row in batch {
                let receipt = row.ticket_id.as_ref().and_then(|id| receipts.get(id));
                let (status,error,missing) = match receipt {
                    Some(receipt) => {
                        if receipt.status == "ok" { ("receipt_ok", None, false) }
                        else if receipt.status == "error" { ("receipt_error", receipt.error.as_deref(), false) }
                        else {
                            tracing::warn!(status = %receipt.status, "invalid Expo receipt status");
                            ("receipt_error", Some("invalid_status"), false)
                        }
                    }
                    None if row.created_at < expires => ("receipt_error", Some("missing"), true),
                    None => continue,
                };
                // Another receipt pass may have reconciled the same snapshot already.
                let changed = sqlx::query("UPDATE push_tickets SET status=$2,error_code=$3,checked_at=$4 WHERE id=$1 AND status='pending_receipt'")
                    .bind(row.id).bind(status).bind(error).bind(now).execute(&mut *tx).await?.rows_affected();
                if changed == 0 { continue; }
                if missing { report.missing += 1; }
                else if status == "receipt_ok" { report.ok += 1; }
                else { report.errors += 1; }
                if error == Some("DeviceNotRegistered") {
                    let removed = sqlx::query("DELETE FROM devices WHERE token=$1 AND store_id=$2")
                        .bind(&row.token).bind(row.store_id).execute(&mut *tx).await?.rows_affected();
                    report.unregistered += removed as usize;
                }
            }
            tx.commit().await?;
        }
        tracing::info!(ok = report.ok, errors = report.errors, unregistered = report.unregistered, missing = report.missing, "push receipt check completed");
        Ok(report)
    }).await
}
