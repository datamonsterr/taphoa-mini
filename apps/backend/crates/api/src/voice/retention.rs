//! Daily deletion of utterance rows older than 30 days. Rows kept for donated clips stay.
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
