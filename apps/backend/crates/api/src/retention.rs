//! Daily compaction of sync history and cleanup of published outbox events.
use sqlx::PgPool;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

#[derive(Debug)]
pub struct RetentionReport {
    pub change_log_deleted: u64,
    pub outbox_deleted: u64,
}

pub async fn run_once(pool: &PgPool) -> anyhow::Result<RetentionReport> {
    crate::telemetry::job("retention", 1, async {
        let result = async {
            let mut tx = pool.begin().await?;
            // Deletions and their cursor floors must become visible together. The highest
            // sequence, rather than timestamp, determines the newest row for an entity.
            let change_log_deleted: i64 = sqlx::query_scalar(
                "
        WITH deleted AS (
            DELETE FROM change_log old
            WHERE old.created_at < now() - interval '30 days'
              AND EXISTS (
                SELECT 1 FROM change_log newer
                WHERE newer.store_id=old.store_id AND newer.entity=old.entity
                  AND newer.entity_id=old.entity_id AND newer.seq>old.seq
              )
            RETURNING store_id, seq
        ), floors AS (
            INSERT INTO change_log_floor (store_id, floor_seq)
            SELECT store_id, max(seq) FROM deleted GROUP BY store_id ORDER BY store_id
            ON CONFLICT (store_id) DO UPDATE
            SET floor_seq=GREATEST(change_log_floor.floor_seq, EXCLUDED.floor_seq)
        )
        SELECT count(*) FROM deleted",
            )
            .fetch_one(&mut *tx)
            .await?;
            let outbox_deleted = sqlx::query(
                "DELETE FROM outbox_events WHERE published_at < now() - interval '7 days'",
            )
            .execute(&mut *tx)
            .await?
            .rows_affected();
            tx.commit().await?;
            Ok(RetentionReport {
                change_log_deleted: change_log_deleted as u64,
                outbox_deleted,
            })
        }
        .await;
        if let Err(error) = &result {
            crate::error::log_anyhow_error!(error, error, "retention job failed");
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
                    // The first tick is immediate; subsequent ticks are daily.
                    interval.tick().await;
                    let _ = run_once(&pool).await;
                }
            } => {},
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_stops_without_waiting_for_database_or_daily_tick() {
        // An unreachable server keeps run_once waiting for a database connection.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(30))
            .connect_lazy("postgres://unused:unused@localhost:1/unused")
            .unwrap();
        for initially_stopped in [true, false] {
            let (send, receive) = watch::channel(initially_stopped);
            let task = spawn(pool.clone(), receive);
            tokio::task::yield_now().await;
            if !initially_stopped {
                send.send(true).unwrap();
            }
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .expect("retention must stop promptly")
                .unwrap();
        }
    }
}
