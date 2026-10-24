//! Durable reference embedding jobs, with LISTEN wakeups and polling recovery.
use super::enroll::vector_text;
use crate::{
    events::{self, Event},
    recognition::service::CROP_PADDING,
    storage::ObjectStore,
};
use anyhow::{Context, ensure};
use serde_json::json;
use sqlx::{PgConnection, PgPool, postgres::PgListener};
use std::{sync::Arc, time::Duration};
use taphoa_recognition::{Embedder, crop};
use tokio::{sync::watch, task::JoinHandle};
use uuid::Uuid;

const MAX_ATTEMPTS: i32 = 5;
const BACKOFF_CAP: Duration = Duration::from_secs(300);

/// Enqueue within the caller's transaction. Notifications become visible on commit.
/// Concurrent callers serialize on the product row and reuse an existing queued job.
pub async fn enqueue(
    conn: &mut PgConnection,
    store_id: Uuid,
    product_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        "UPDATE products SET index_status='pending' WHERE id=$1 AND store_id=$2 RETURNING id",
    )
    .bind(product_id)
    .bind(store_id)
    .fetch_one(&mut *conn)
    .await?;
    let existing = sqlx::query_scalar(
        "SELECT id FROM index_jobs WHERE store_id=$1 AND product_id=$2 AND status='queued'
         ORDER BY created_at, id LIMIT 1",
    )
    .bind(store_id)
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await?;
    let id = match existing {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                "INSERT INTO index_jobs (store_id, product_id) VALUES ($1,$2) RETURNING id",
            )
            .bind(store_id)
            .bind(product_id)
            .fetch_one(&mut *conn)
            .await?
        }
    };
    sqlx::query("SELECT pg_notify('index_jobs', $1)")
        .bind(format!("{id}"))
        .execute(&mut *conn)
        .await?;
    Ok(id)
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub poll_interval: Duration,
    /// Retry delay is `min(backoff_base * 2^attempts, 5 minutes)`.
    pub backoff_base: Duration,
    pub stale_lease: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(5),
            backoff_base: Duration::from_secs(1),
            stale_lease: Duration::from_secs(600),
        }
    }
}

/// Start only when Postgres, object storage and an embedder are configured.
pub fn spawn(
    pool: PgPool,
    embedder: Arc<dyn Embedder>,
    storage: Arc<dyn ObjectStore>,
    inference_slots: Arc<tokio::sync::Semaphore>,
    mut shutdown: watch::Receiver<bool>,
    config: WorkerConfig,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            biased;
            () = async {
                loop {
                    if *shutdown.borrow_and_update() || shutdown.changed().await.is_err() {
                        break;
                    }
                }
            } => {},
            () = worker_loop(pool, embedder, storage, inference_slots, config) => {},
        }
        // A cancelled claim remains running and is recovered after its lease expires.
        // Blocking inference retains its permit until it actually finishes.
        tracing::info!("index job worker stopped");
    })
}

async fn worker_loop(
    pool: PgPool,
    embedder: Arc<dyn Embedder>,
    storage: Arc<dyn ObjectStore>,
    slots: Arc<tokio::sync::Semaphore>,
    config: WorkerConfig,
) {
    let mut listener = None;
    loop {
        let poll_at = tokio::time::Instant::now() + config.poll_interval;
        // Subscribe before draining so commits between the drain and wait are buffered.
        if listener.is_none() {
            let connect = async {
                let mut listener = PgListener::connect_with(&pool).await?;
                listener.listen("index_jobs").await?;
                Ok::<_, sqlx::Error>(listener)
            };
            match tokio::time::timeout(Duration::from_secs(1), connect).await {
                Ok(Ok(connected)) => listener = Some(connected),
                _ => tracing::warn!("index_jobs LISTEN unavailable; polling until reconnect"),
            }
        }
        loop {
            match process_next(
                &pool,
                embedder.clone(),
                storage.clone(),
                slots.clone(),
                &config,
            )
            .await
            {
                Ok(true) => continue,
                Ok(false) => break,
                Err(error) => {
                    tracing::warn!(%error, "index job iteration failed");
                    // Do not spin on database errors even with a busy notification stream.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    break;
                }
            }
        }
        if let Some(connected) = listener.as_mut() {
            if matches!(
                tokio::time::timeout_at(poll_at, connected.recv()).await,
                Ok(Err(_))
            ) {
                tracing::warn!("index_jobs LISTEN failed; reconnecting");
                listener = None;
            }
        } else {
            tokio::time::sleep_until(poll_at).await;
        }
    }
}

#[derive(sqlx::FromRow)]
struct ClaimedJob {
    id: Uuid,
    store_id: Uuid,
    product_id: Uuid,
    attempts: i32,
}

/// Recover expired leases and process at most one due job. `false` means no work.
/// Processing errors are persisted as retries; database errors propagate to the caller.
pub async fn process_next(
    pool: &PgPool,
    embedder: Arc<dyn Embedder>,
    storage: Arc<dyn ObjectStore>,
    inference_slots: Arc<tokio::sync::Semaphore>,
    config: &WorkerConfig,
) -> anyhow::Result<bool> {
    sqlx::query(
        "UPDATE index_jobs SET status='queued', run_after=now(), updated_at=now()
         WHERE id IN (SELECT id FROM index_jobs WHERE status='running'
             AND updated_at < now() - make_interval(secs => $1) FOR UPDATE SKIP LOCKED)",
    )
    .bind(config.stale_lease.as_secs_f64())
    .execute(pool)
    .await?;
    let job: Option<ClaimedJob> = sqlx::query_as(
        "UPDATE index_jobs SET status='running', attempts=attempts+1, updated_at=now()
         WHERE id=(SELECT id FROM index_jobs WHERE status='queued' AND run_after<=now()
             ORDER BY run_after, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, store_id, product_id, attempts",
    )
    .fetch_optional(pool)
    .await?;
    let Some(job) = job else { return Ok(false) };
    if let Err(error) = run_job(pool, embedder, storage, inference_slots, &job).await {
        tracing::warn!(job_id=%job.id, %error, attempts=job.attempts, "index job failed");
        schedule_retry(pool, &job, format!("{error:#}"), config).await?;
    }
    Ok(true)
}

#[derive(Debug, PartialEq, sqlx::FromRow)]
struct ProductImage {
    image_id: Uuid,
    object_key: String,
    cutout_object_key: Option<String>,
    bbox: Option<Vec<f32>>,
}

async fn references(
    conn: &mut PgConnection,
    job: &ClaimedJob,
) -> Result<Vec<ProductImage>, sqlx::Error> {
    sqlx::query_as(
        "SELECT pi.image_id, i.object_key, ci.object_key AS cutout_object_key, pi.bbox
         FROM product_images pi JOIN images i ON i.id=pi.image_id AND i.store_id=$2
         LEFT JOIN images ci ON ci.id=pi.cutout_image_id AND ci.store_id=$2
         WHERE pi.product_id=$1 ORDER BY pi.position, pi.image_id",
    )
    .bind(job.product_id)
    .bind(job.store_id)
    .fetch_all(conn)
    .await
}

struct Embedding {
    image_id: Uuid,
    kind: &'static str,
    vector: Vec<f32>,
}

/// Serialize with enqueue, then fence workers whose lease was reclaimed.
/// The event helper takes the store lock after product writes, as catalog handlers do.
async fn lock_claim(conn: &mut PgConnection, job: &ClaimedJob) -> Result<bool, sqlx::Error> {
    sqlx::query("SELECT id FROM products WHERE id=$1 AND store_id=$2 FOR NO KEY UPDATE")
        .bind(job.product_id)
        .bind(job.store_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM index_jobs WHERE id=$1 AND status='running' AND attempts=$2 FOR UPDATE",
    )
    .bind(job.id)
    .bind(job.attempts)
    .fetch_optional(conn)
    .await?
    .is_some())
}

async fn run_job(
    pool: &PgPool,
    embedder: Arc<dyn Embedder>,
    storage: Arc<dyn ObjectStore>,
    slots: Arc<tokio::sync::Semaphore>,
    job: &ClaimedJob,
) -> anyhow::Result<()> {
    let images = references(&mut *pool.acquire().await?, job).await?;
    let model = embedder.model().to_owned();
    let mut embeddings = Vec::with_capacity(images.len() * 2);
    for image in &images {
        let bbox = image
            .bbox
            .as_deref()
            .map(<[f32; 4]>::try_from)
            .transpose()
            .context("invalid reference bbox")?;
        let bytes = storage.get(&image.object_key).await?;
        embeddings.push(Embedding {
            image_id: image.image_id,
            kind: "crop",
            vector: embed_image(embedder.clone(), slots.clone(), bytes, bbox).await?,
        });
        if let Some(key) = &image.cutout_object_key {
            embeddings.push(Embedding {
                // Both views belong to the reference, distinguished by kind.
                image_id: image.image_id,
                kind: "cutout",
                vector: embed_image(
                    embedder.clone(),
                    slots.clone(),
                    storage.get(key).await?,
                    None,
                )
                .await?,
            });
        }
    }
    let prototype = compute_prototype(&embeddings);
    let reference_count = images.len() as i32;
    let mut tx = pool.begin().await?;
    if !lock_claim(&mut tx, job).await? {
        return Ok(());
    }
    // Enqueue uses the same product lock. If references changed during inference,
    // retry from a fresh snapshot instead of publishing stale embeddings as ready.
    ensure!(
        references(&mut tx, job).await? == images,
        "references changed during indexing"
    );
    for embedding in &embeddings {
        sqlx::query(
            "INSERT INTO product_embeddings (store_id, product_id, image_id, model, kind, embedding)
             VALUES ($1,$2,$3,$4,$5,$6::vector)
             ON CONFLICT (store_id, product_id, image_id, model, kind)
             DO UPDATE SET embedding=EXCLUDED.embedding",
        ).bind(job.store_id).bind(job.product_id).bind(embedding.image_id).bind(&model)
            .bind(embedding.kind).bind(vector_text(&embedding.vector)).execute(&mut *tx).await?;
    }
    sqlx::query(
        "DELETE FROM product_embeddings e WHERE e.product_id=$1 AND e.store_id=$2
         AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id=e.product_id
             AND pi.image_id=e.image_id AND (e.kind='crop' OR pi.cutout_image_id IS NOT NULL))",
    )
    .bind(job.product_id)
    .bind(job.store_id)
    .execute(&mut *tx)
    .await?;
    if let Some(prototype) = prototype {
        sqlx::query(
            "INSERT INTO product_prototypes (store_id,product_id,model,embedding,reference_count)
             VALUES ($1,$2,$3,$4::vector,$5) ON CONFLICT (product_id,model)
             DO UPDATE SET embedding=EXCLUDED.embedding, reference_count=EXCLUDED.reference_count, updated_at=now()",
        ).bind(job.store_id).bind(job.product_id).bind(&model).bind(vector_text(&prototype))
            .bind(reference_count).execute(&mut *tx).await?;
    } else {
        sqlx::query(
            "DELETE FROM product_prototypes WHERE store_id=$1 AND product_id=$2 AND model=$3",
        )
        .bind(job.store_id)
        .bind(job.product_id)
        .bind(&model)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE products SET index_status='ready', updated_at=now() WHERE id=$1 AND store_id=$2",
    )
    .bind(job.product_id)
    .bind(job.store_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE index_jobs SET status='done', last_error=NULL, updated_at=now() WHERE id=$1",
    )
    .bind(job.id)
    .execute(&mut *tx)
    .await?;
    emit_indexed(&mut tx, job, "ready", reference_count).await?;
    tx.commit().await?;
    Ok(())
}

async fn schedule_retry(
    pool: &PgPool,
    job: &ClaimedJob,
    error: String,
    config: &WorkerConfig,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    if !lock_claim(&mut tx, job).await? {
        return Ok(());
    }
    if job.attempts >= MAX_ATTEMPTS {
        sqlx::query(
            "UPDATE index_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1",
        )
        .bind(job.id)
        .bind(&error)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE products SET index_status='failed', updated_at=now() WHERE id=$1 AND store_id=$2")
            .bind(job.product_id).bind(job.store_id).execute(&mut *tx).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM product_images WHERE product_id=$1")
                .bind(job.product_id)
                .fetch_one(&mut *tx)
                .await?;
        emit_indexed(&mut tx, job, "failed", count as i32).await?;
    } else {
        let delay = config
            .backoff_base
            .saturating_mul(1u32 << job.attempts)
            .min(BACKOFF_CAP);
        sqlx::query(
            "UPDATE index_jobs SET status='queued', last_error=$2,
             run_after=now()+make_interval(secs => $3), updated_at=now() WHERE id=$1",
        )
        .bind(job.id)
        .bind(&error)
        .bind(delay.as_secs_f64())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn emit_indexed(
    conn: &mut PgConnection,
    job: &ClaimedJob,
    status: &str,
    count: i32,
) -> Result<(), sqlx::Error> {
    events::emit(conn, Event {
        store_id: job.store_id, actor: None, typ: "product.indexed", version: 1,
        data: json!({"product_id":job.product_id,"index_status":status,"reference_count":count}),
        change: None,
    }).await?;
    Ok(())
}

async fn embed_image(
    embedder: Arc<dyn Embedder>,
    slots: Arc<tokio::sync::Semaphore>,
    bytes: Vec<u8>,
    bbox: Option<[f32; 4]>,
) -> anyhow::Result<Vec<f32>> {
    let permit = slots.acquire_owned().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let decoded = crop::decode_limited(&bytes).map_err(anyhow::Error::msg)?;
        let cropped;
        let input = if let Some(bbox) = bbox {
            let image = crop::crop_with_padding(&decoded.into_rgb8(), bbox, CROP_PADDING)
                .context("empty bbox crop")?;
            let mut png = std::io::Cursor::new(Vec::new());
            image.write_to(&mut png, image::ImageFormat::Png)?;
            cropped = png.into_inner();
            &cropped
        } else {
            // Preserve whole-image legacy enrollment and stored cutout bytes.
            &bytes
        };
        let vector = embedder.embed(input)?;
        ensure!(
            vector.len() == 384 && vector.len() == embedder.dim(),
            "invalid embedding dimension"
        );
        ensure!(vector.iter().all(|v| v.is_finite()), "non-finite embedding");
        Ok(vector)
    })
    .await?
}

fn compute_prototype(embeddings: &[Embedding]) -> Option<Vec<f32>> {
    if embeddings.is_empty() {
        return None;
    }
    let mut mean = vec![0f64; 384];
    for embedding in embeddings {
        for (sum, value) in mean.iter_mut().zip(&embedding.vector) {
            *sum += f64::from(*value);
        }
    }
    let mut mean: Vec<f32> = mean
        .iter()
        .map(|sum| (sum / embeddings.len() as f64) as f32)
        .collect();
    crop::l2_normalize(&mut mean);
    Some(mean)
}
