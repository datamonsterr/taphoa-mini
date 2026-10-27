//! The eval store "Tạp hóa Cô Ba": a deterministic fixture for the assistant golden set.
//! `packages/eval/STORE.md` lists every fixture by name.
//!
//! The whole dataset is generated in memory first ([`build::build`], no clock, no entropy,
//! business date pinned to 2026-10-20 in Asia/Ho_Chi_Minh) and then written in one transaction
//! under an advisory lock. Identity (store credentials, members, sessions, invites) is written by
//! one function, `insert::insert_identity` (store, members with Clerk user ids, invites).
mod build;
mod catalog;
mod insert;
mod ledger;
mod model;
mod sales;
mod supply;
#[cfg(test)]
mod tests;

use crate::seed::{ClerkUsers, member_email};
use anyhow::{Context, Result, bail};
use chrono::NaiveDate;
use sqlx::PgPool;
use uuid::Uuid;

/// Distinct from the v1 fixture locks (7_063_001 and 7_063_002).
const ADVISORY_LOCK: i64 = 7_063_100;

#[derive(Clone, Copy, Default)] // no Debug: ClerkUsers holds the secret key
pub struct EvalOptions<'a> {
    /// Delete the eval store and everything it owns, then seed it again.
    pub reset: bool,
    /// Links the members that can sign in to Clerk test users; `None` keeps placeholder ids.
    pub clerk: Option<&'a ClerkUsers>,
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
    pub clerk_linked: bool,
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
    pub pin: Option<String>,
    /// Clerk test-user email (`+clerk_test`, verification code 424242).
    pub email: String,
    /// The linked Clerk user id; `None` for members that cannot sign in or without a client.
    pub clerk_user_id: Option<String>,
}

/// The eval seed writes demo credentials and a pinned date; it must never run in production.
pub fn ensure_not_production(railway_environment: Option<&str>) -> Result<()> {
    if railway_environment == Some("production") {
        bail!("refusing to seed the eval store: RAILWAY_ENVIRONMENT_NAME is production");
    }
    Ok(())
}

pub async fn run(pool: &PgPool, options: EvalOptions<'_>) -> Result<EvalReport> {
    let data = build::build();
    // Clerk first: nothing is written to the database when Clerk fails.
    let clerk_ids = insert::clerk_user_ids(options.clerk, &data).await?;
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
        insert::insert_all(&mut tx, &data, &clerk_ids)
            .await
            .context("seed the eval store")?;
    } else {
        insert::link_members(&mut tx, &data, &clerk_ids)
            .await
            .context("link Clerk users of the eval store")?;
    }
    tx.commit().await.context("commit eval seed transaction")?;
    Ok(EvalReport {
        status,
        store_id: data.store.id,
        name: data.store.name.to_string(),
        business_date: data.today,
        clerk_linked: options.clerk.is_some(),
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
                email: member_email(insert::CLERK_STORE_KEY, m.key),
                clerk_user_id: clerk_ids.get(&m.id).cloned(),
            })
            .collect(),
    })
}
