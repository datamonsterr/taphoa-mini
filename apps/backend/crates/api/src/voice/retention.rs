//! Daily deletion of utterance rows older than 30 days. Rows kept for donated clips stay.
use sqlx::PgPool;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

pub const RETENTION_DAYS: i32 = 30;

pub async fn run_once(pool: &PgPool) -> anyhow::Result<u64> {
    crate::telemetry::job("voice_retention", 1, async {
        let result = sqlx::query(
            "DELETE FROM voice_utterances WHERE created_at < now() - make_interval(days => $1) AND NOT donated",
        )
        .bind(RETENTION_DAYS)
        .execute(pool)
        .await
        .map(|done| done.rows_affected())
        .map_err(anyhow::Error::from);
        if let Err(error) = &result {
            crate::error::log_anyhow_error!(error, error, "voice retention job failed");
        }
        result
    })
    .await
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
