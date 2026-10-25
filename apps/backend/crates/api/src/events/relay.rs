//! At-least-once delivery of committed outbox rows to Redis.
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgListener};
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};
use tracing::Instrument;
use uuid::Uuid;

use super::{Backoff, stopped};

pub fn spawn(
    pool: PgPool,
    redis_url: String,
    mut shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            biased;
            () = stopped(&mut shutdown) => {},
            () = run(pool, redis_url) => {},
        }
        // Cancelling an iteration drops its transaction, rolling back any marks.
        // Rows already published are retried, preserving at-least-once delivery.
        tracing::info!("outbox relay stopped");
    })
}

async fn run(pool: PgPool, redis_url: String) {
    let mut connection = None;
    let mut listener = None;
    let mut backoff = Backoff::default();
    loop {
        if connection.is_none() {
            let connect = async {
                let client = redis::Client::open(redis_url.as_str())?;
                let config = ConnectionManagerConfig::new()
                    .set_number_of_retries(0)
                    .set_connection_timeout(Some(Duration::from_secs(1)))
                    .set_response_timeout(Some(Duration::from_secs(1)));
                ConnectionManager::new_with_config(client, config).await
            };
            match connect.await {
                Ok(manager) => connection = Some(manager),
                Err(_) => {
                    tracing::warn!("outbox Redis connection failed; retrying");
                    backoff.sleep().await;
                    continue;
                }
            }
        }
        let poll_at = tokio::time::Instant::now() + Duration::from_secs(1);
        if listener.is_none() {
            let connect = async {
                let mut listener = PgListener::connect_with(&pool).await?;
                listener.listen("outbox").await?;
                Ok::<_, sqlx::Error>(listener)
            };
            match tokio::time::timeout(Duration::from_secs(1), connect).await {
                Ok(Ok(connected)) => listener = Some(connected),
                _ => tracing::warn!("outbox LISTEN unavailable; polling until reconnect"),
            }
        }
        let result = publish_batch(
            &pool,
            connection.as_mut().expect("connected above"),
            &crate::telemetry::server_address(&redis_url),
        )
        .await;
        match result {
            Ok((count, true)) => {
                if count > 0 {
                    backoff.reset();
                }
                tracing::warn!("outbox publish failed; retrying unpublished rows");
                connection = None;
                backoff.sleep().await;
                continue;
            }
            Ok((count, false)) => {
                backoff.reset();
                if count == 100 {
                    continue;
                }
            }
            Err(_) => {
                tracing::warn!("outbox transaction failed; retrying");
                backoff.sleep().await;
                continue;
            }
        }
        if let Some(connected) = listener.as_mut() {
            if matches!(
                tokio::time::timeout_at(poll_at, connected.recv()).await,
                Ok(Err(_))
            ) {
                tracing::warn!("outbox LISTEN failed; reconnecting");
                listener = None;
            }
        } else {
            tokio::time::sleep_until(poll_at).await;
        }
    }
}

/// Commit only the successfully published prefix, even when Redis fails mid-batch.
async fn publish_batch(
    pool: &PgPool,
    connection: &mut ConnectionManager,
    address: &str,
) -> Result<(usize, bool), sqlx::Error> {
    let started = std::time::Instant::now();
    let result = prepare_batch(pool, connection, address).await;
    if let Err((_, false)) = &result {
        // Errors before rows can be loaded still get a job span; successful empty polls do not.
        let span = crate::telemetry::job_span("outbox_relay", 1);
        span.record("taphoa.job.outcome", "error");
        span.in_scope(|| {
            tracing::warn!(
                duration_ms = started.elapsed().as_secs_f64() * 1000.0,
                "outbox batch failed"
            )
        });
    }
    result.map_err(|(error, _)| error)
}

async fn prepare_batch(
    pool: &PgPool,
    connection: &mut ConnectionManager,
    address: &str,
) -> Result<(usize, bool), (sqlx::Error, bool)> {
    let mut tx = pool.begin().await.map_err(|e| (e, false))?;
    let rows: Vec<(i64, Uuid, Value)> = sqlx::query_as(
        "SELECT id, store_id, payload FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await.map_err(|e| (e, false))?;
    if rows.is_empty() {
        tx.commit().await.map_err(|e| (e, false))?;
        return Ok((0, false));
    }
    let span = crate::telemetry::job_span("outbox_relay", 1);
    let mut outcome = crate::telemetry::Outcome::new(&span, "taphoa.job.outcome");
    async {
        let result = async {
            let mut published = Vec::with_capacity(rows.len());
            let mut failed = false;
            for (id, store_id, payload) in rows {
                let result = crate::telemetry::client("redis PUBLISH", address, async {
                    redis::cmd("PUBLISH")
                        .arg(format!("store:{store_id}:events"))
                        .arg(payload.to_string())
                        .query_async::<i64>(connection)
                        .await
                })
                .await;
                if result.is_err() {
                    failed = true;
                    break;
                }
                published.push(id);
            }
            if !published.is_empty() {
                sqlx::query("UPDATE outbox_events SET published_at=now() WHERE id = ANY($1)")
                    .bind(&published)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            Ok((published.len(), failed))
        }
        .await;
        let failed = !matches!(result, Ok((_, false)));
        outcome.finish(!failed);
        if failed {
            tracing::warn!("outbox batch failed");
        }
        result
    }
    .instrument(span)
    .await
    .map_err(|e| (e, true))
}
