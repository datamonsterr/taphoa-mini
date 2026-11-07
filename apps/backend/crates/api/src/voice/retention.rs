//! Daily deletion of expired utterances and donated audio.
use sqlx::PgPool;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

pub const RETENTION_DAYS: i32 = 30;
/// Rows per DELETE, so a large backlog never holds one long lock or bloats one transaction.
pub const BATCH: i64 = 5000;

pub async fn run_once(pool: &PgPool) -> anyhow::Result<u64> {
    run_batched(pool, BATCH).await
}

pub async fn run_batched(pool: &PgPool, batch: i64) -> anyhow::Result<u64> {
    crate::telemetry::job("voice_retention", 1, async {
        let result = delete_old(pool, batch).await;
        if let Err(error) = &result {
            crate::error::log_anyhow_error!(error, error, "voice retention job failed");
        }
        result
    })
    .await
}

async fn delete_old(pool: &PgPool, batch: i64) -> anyhow::Result<u64> {
    let mut total = 0;
    loop {
        let done = sqlx::query(
            "DELETE FROM voice_utterances WHERE id IN (
                SELECT id FROM voice_utterances
                WHERE created_at < now() - make_interval(days => $1) AND NOT donated
                ORDER BY created_at LIMIT $2)",
        )
        .bind(RETENTION_DAYS)
        .bind(batch)
        .execute(pool)
        .await?
        .rows_affected();
        total += done;
        if (done as i64) < batch {
            return Ok(total);
        }
    }
}

pub fn spawn(pool: PgPool, mut shutdown: watch::Receiver<bool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = async {
                loop {
                    if *shutdown.borrow_and_update() || shutdown.changed().await.is_err() {
                        break;
                    }
                }
            } => {},
            _ = async {
                let mut interval = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    let _ = run_once(&pool).await;
                }
            } => {},
        }
    })
}

/// Delete donated audio and its row under a row lock. Failed object deletion leaves the row
/// available for retry. The deterministic keys cover every accepted audio format.
pub async fn delete_donated_for_store(
    pool: &PgPool,
    storage: &dyn crate::storage::ObjectStore,
    store_id: uuid::Uuid,
    days: i32,
) -> anyhow::Result<u64> {
    delete_donated(pool, storage, Some(store_id), days).await
}

async fn delete_donated(
    pool: &PgPool,
    storage: &dyn crate::storage::ObjectStore,
    store_id: Option<uuid::Uuid>,
    days: i32,
) -> anyhow::Result<u64> {
    let mut total = 0;
    let mut failures = 0_u64;
    loop {
        let mut tx = pool.begin().await?;
        let row: Option<(uuid::Uuid, uuid::Uuid)> = sqlx::query_as(
            "SELECT utterance_id, store_id FROM voice_donations WHERE created_at < now() - make_interval(days => $1) AND next_attempt_at <= now() AND ($2::uuid IS NULL OR store_id=$2) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"
        ).bind(days).bind(store_id).fetch_optional(&mut *tx).await?;
        let Some((id, store)) = row else {
            tx.commit().await?;
            tracing::info!(
                deleted = total,
                failures,
                "donated voice retention pass complete"
            );
            return Ok(total);
        };
        let mut failure = None;
        for ext in ["m4a", "wav", "ogg"] {
            if let Err(error) = storage.delete(&format!("voice/{store}/{id}.{ext}")).await {
                failure = Some(error);
                break;
            }
        }
        if let Some(error) = failure {
            let message: String = error.to_string().chars().take(512).collect();
            sqlx::query("UPDATE voice_donations SET attempts=attempts+1, last_error=$2, next_attempt_at=now()+make_interval(secs => LEAST(3600, 60 * power(2, LEAST(attempts, 6)))::double precision) WHERE utterance_id=$1")
                .bind(id).bind(message).execute(&mut *tx).await?;
            tx.commit().await?;
            failures += 1;
            crate::error::log_anyhow_error!(error, &error, %store, %id, "donated voice deletion failed; will retry");
            continue;
        }
        sqlx::query("DELETE FROM voice_utterances WHERE id=$1 AND store_id=$2 AND donated")
            .bind(id)
            .bind(store)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM voice_donations WHERE utterance_id=$1 AND store_id=$2")
            .bind(id)
            .bind(store)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        total += 1;
    }
}

pub fn spawn_donated(
    pool: PgPool,
    storage: std::sync::Arc<dyn crate::storage::ObjectStore>,
    days: i32,
    mut shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = async { loop { if *shutdown.borrow_and_update() || shutdown.changed().await.is_err() { break; } } } => {},
            _ = async {
                let mut interval = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    if let Err(error) = delete_donated(&pool, storage.as_ref(), None, days).await {
                        crate::error::log_anyhow_error!(error, &error, "donated voice retention failed");
                    }
                }
            } => {},
        }
    })
}
