//! The eval store "Tạp hóa Cô Ba": a deterministic fixture for the assistant golden set.
//! `packages/eval/STORE.md` lists every fixture by name.
//!
//! The whole dataset is generated in memory first ([`build::build`], no clock, no entropy,
//! business date pinned to 2026-10-20 in Asia/Ho_Chi_Minh) and then written in one transaction
//! under an advisory lock. Identity (store credentials, members, sessions, invites) is written by
//! one function, `insert::insert_identity`, so the Clerk migration only touches that function.
mod build;
mod catalog;
mod insert;
mod ledger;
mod model;
mod sales;
mod supply;
#[cfg(test)]
mod tests;

use anyhow::{Context, Result, bail};
use chrono::NaiveDate;
use sqlx::PgPool;
use uuid::Uuid;

/// Distinct from the v1 fixture locks (7_063_001 and 7_063_002).
const ADVISORY_LOCK: i64 = 7_063_100;

#[derive(Debug, Clone, Copy, Default)]
pub struct EvalOptions {
    /// Delete the eval store and everything it owns, then seed it again.
    pub reset: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalStatus {
    /// The store did not exist and was seeded.
    Created,
    /// The store already existed; nothing was written.
    Existing,
    /// The store existed, was deleted and seeded again.
    Reset,
}

/// Contains local credentials. Deliberately does not implement Debug or Serialize.
pub struct EvalReport {
    pub status: EvalStatus,
    pub store_id: Uuid,
    pub name: String,
    pub business_date: NaiveDate,
    pub recovery_code: String,
    pub invite_token: String,
    pub members: Vec<EvalMember>,
}

pub struct EvalMember {
    pub member_id: Uuid,
    /// Stable key (the identity layer derives Clerk emails from it).
    pub key: String,
    pub display_name: String,
    pub role: String,
    pub can_enroll: bool,
    /// Members without a PIN and a session cannot log in.
    pub pin: Option<String>,
    pub refresh_token: Option<String>,
}

/// The eval seed writes demo credentials and a pinned date; it must never run in production.
pub fn ensure_not_production(railway_environment: Option<&str>) -> Result<()> {
    if railway_environment == Some("production") {
        bail!("refusing to seed the eval store: RAILWAY_ENVIRONMENT_NAME is production");
    }
    Ok(())
}

pub async fn run(pool: &PgPool, options: EvalOptions) -> Result<EvalReport> {
    let data = build::build();
    let mut tx = pool.begin().await.context("begin eval seed transaction")?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(ADVISORY_LOCK)
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM stores WHERE id=$1)")
        .bind(data.store.id)
        .fetch_one(&mut *tx)
        .await?;
    let status = match (exists, options.reset) {
        (true, false) => EvalStatus::Existing,
        (true, true) => {
            insert::delete_store(&mut tx, data.store.id)
                .await
                .context("delete the previous eval store")?;
            EvalStatus::Reset
        }
        (false, _) => EvalStatus::Created,
    };
    if status != EvalStatus::Existing {
        insert::insert_all(&mut tx, &data)
            .await
            .context("seed the eval store")?;
    }
    tx.commit().await.context("commit eval seed transaction")?;
    Ok(EvalReport {
        status,
        store_id: data.store.id,
        name: data.store.name.to_string(),
        business_date: data.today,
        recovery_code: data.identity.recovery_code.clone(),
        invite_token: data
            .identity
            .invites
            .iter()
            .find(|i| i.used_at.is_none())
            .map(|i| i.token.clone())
            .unwrap_or_default(),
        members: data
            .identity
            .members
            .iter()
            .map(|m| EvalMember {
                member_id: m.id,
                key: m.key.to_string(),
                display_name: m.name.to_string(),
                role: m.role.to_string(),
                can_enroll: m.can_enroll,
                pin: m.pin.map(str::to_string),
                refresh_token: m.session.as_ref().map(|s| s.refresh_token.to_string()),
            })
            .collect(),
    })
}
