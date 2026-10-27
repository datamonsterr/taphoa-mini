//! At-least-once delivery of committed outbox rows to Redis.
use crate::analytics::Analytics;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgListener};
use std::{sync::Arc, time::Duration};
use tokio::{sync::watch, task::JoinHandle};
use tracing::Instrument;
use uuid::Uuid;

use super::{Backoff, stopped};

pub fn spawn(
    pool: PgPool,
    redis_url: String,
    mut shutdown: watch::Receiver<bool>,
    analytics: Arc<dyn Analytics>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            biased;
            () = stopped(&mut shutdown) => {},
            () = run(pool, redis_url, analytics) => {},
        }
        // Cancelling an iteration drops its transaction, rolling back any marks.
        // Rows already published are retried, preserving at-least-once delivery.
        tracing::info!("outbox relay stopped");
    })
}

async fn run(pool: PgPool, redis_url: String, analytics: Arc<dyn Analytics>) {
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
            analytics.clone(),
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
    analytics: Arc<dyn Analytics>,
) -> Result<(usize, bool), sqlx::Error> {
    let started = std::time::Instant::now();
    let result = prepare_batch(pool, connection, address, analytics).await;
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
    analytics: Arc<dyn Analytics>,
) -> Result<(usize, bool), (sqlx::Error, bool)> {
    let mut tx = pool.begin().await.map_err(|e| (e, false))?;
    let rows: Vec<(i64, Uuid, String, Value)> = sqlx::query_as(
        "SELECT id, store_id, type, payload FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
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
            let mut captures = Vec::with_capacity(rows.len());
            for (id, store_id, typ, mut payload) in rows {
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
                // Analytics must not interrupt publication of even a malformed envelope.
                if let Some(object) = payload.as_object_mut() {
                    object.insert("type".into(), Value::String(typ));
                    captures.push(payload);
                } else {
                    tracing::warn!("malformed outbox envelope skipped by product analytics");
                }
            }
            if !published.is_empty() {
                sqlx::query("UPDATE outbox_events SET published_at=now() WHERE id = ANY($1)")
                    .bind(&published)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            if !captures.is_empty() {
                let pool = pool.clone();
                tokio::spawn(async move {
                    let members =
                        match super::product_events::lookup_members(&pool, &captures).await {
                            Ok(members) => members,
                            Err(_) => {
                                tracing::warn!("product analytics members lookup failed");
                                return;
                            }
                        };
                    for envelope in captures {
                        if let Some(event) = super::product_events::map(&envelope, &members)
                            && analytics.capture_event(event).await.is_err()
                        {
                            tracing::warn!("product analytics capture failed");
                        }
                    }
                });
            }
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

/// Publish one batch, then schedule best-effort analytics after the database commit.
/// Test support only: drives the relay deterministically in service integration tests.
#[doc(hidden)]
pub async fn publish_once(
    pool: &PgPool,
    redis: &mut ConnectionManager,
    analytics: Arc<dyn Analytics>,
) -> Result<(usize, bool), sqlx::Error> {
    publish_batch(pool, redis, "redis", analytics).await
}
