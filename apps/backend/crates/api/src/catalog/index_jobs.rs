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
const KEYFRAME_KEEP: usize = 16;

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

/// Index all deterministic views by default; INDEX_AUGMENT=0 disables extra views.
pub const DEFAULT_INDEX_AUGMENT: bool = true;

/// Limit automatic model upgrades to ten products per pass to avoid flooding inference.
pub const DEFAULT_BACKFILL_BATCH: usize = 10;
/// Model upgrades enqueue at most one batch every thirty seconds, including one at startup.
pub const DEFAULT_BACKFILL_INTERVAL: Duration = Duration::from_secs(30);

/// Queue products lacking current-model vectors. Product locks and active-job checks make
/// repeated/concurrent startup passes idempotent. Failed attempts for this model are left
/// to explicit retries, rather than resetting the worker's bounded failure policy forever.
pub async fn enqueue_stale_model(
    pool: &PgPool,
    model: &str,
    limit: usize,
) -> Result<usize, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let products: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT p.store_id, p.id FROM products p
         WHERE NOT p.archived AND p.index_status<>'pending'
           AND EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id=p.id)
           AND NOT EXISTS (SELECT 1 FROM product_embeddings e
               WHERE e.product_id=p.id AND e.store_id=p.store_id AND e.model=$1)
           AND NOT EXISTS (SELECT 1 FROM index_jobs j WHERE j.product_id=p.id
               AND (j.status IN ('queued','running') OR (j.target_model=$1 AND j.status='failed')))
         ORDER BY p.id LIMIT $2 FOR UPDATE OF p SKIP LOCKED",
    )
    .bind(model)
    .bind(i64::try_from(limit).unwrap_or(i64::MAX))
    .fetch_all(&mut *tx)
    .await?;
    for &(store, product) in &products {
        let job = enqueue(&mut tx, store, product).await?;
        sqlx::query("UPDATE index_jobs SET target_model=$2 WHERE id=$1")
            .bind(job)
            .bind(model)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(products.len())
}

async fn backfill_loop(pool: &PgPool, model: &str, config: &WorkerConfig) {
    loop {
        match enqueue_stale_model(pool, model, config.backfill_batch).await {
            Ok(0) => {}
            Ok(count) => tracing::info!(count, model, "queued model reindex batch"),
            Err(error) => tracing::warn!(%error, "model reindex enqueue failed"),
        }
        // Sleep after the pass so delayed database work cannot cause catch-up bursts.
        tokio::time::sleep(config.backfill_interval).await;
    }
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub poll_interval: Duration,
    /// Retry delay is `min(backoff_base * 2^attempts, 5 minutes)`.
    pub backoff_base: Duration,
    pub stale_lease: Duration,
    pub index_augment: bool,
    pub backfill_batch: usize,
    pub backfill_interval: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(5),
            backoff_base: Duration::from_secs(1),
            stale_lease: Duration::from_secs(600),
            index_augment: DEFAULT_INDEX_AUGMENT,
            backfill_batch: DEFAULT_BACKFILL_BATCH,
            backfill_interval: DEFAULT_BACKFILL_INTERVAL,
        }
    }
}

impl WorkerConfig {
    pub fn from_env() -> Self {
        Self {
            index_augment: !matches!(std::env::var("INDEX_AUGMENT").as_deref(), Ok("0" | "false")),
            ..Self::default()
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
            () = async {
                tokio::join!(
                    backfill_loop(&pool, embedder.model(), &config),
                    worker_loop(pool.clone(), embedder.clone(), storage, inference_slots, config.clone()),
                );
            } => {},
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
                    crate::error::log_anyhow_error!(warn, &error, "index job iteration failed");
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
        "UPDATE index_jobs SET status='running', attempts=attempts+1, updated_at=now(), target_model=$1
         WHERE id=(SELECT id FROM index_jobs WHERE status='queued' AND run_after<=now()
             ORDER BY run_after, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, store_id, product_id, attempts",
    )
    .bind(embedder.model())
    .fetch_optional(pool)
    .await?;
    let Some(job) = job else { return Ok(false) };
    use tracing::Instrument;
    let span = crate::telemetry::job_span("index_job", i64::from(job.attempts));
    let mut outcome = crate::telemetry::Outcome::new(&span, "taphoa.job.outcome");
    async {
        let result = run_job(
            pool,
            embedder,
            storage,
            inference_slots,
            &job,
            config.index_augment,
        )
        .await;
        outcome.finish(result.is_ok());
        if let Err(error) = result {
            crate::error::log_anyhow_error!(
                warn,
                &error,
                job_id = %job.id,
                attempts = job.attempts,
                "index job failed"
            );
            schedule_retry(pool, &job, format!("{error:#}"), config).await?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .instrument(span)
    .await?;

    Ok(true)
}

#[derive(Debug, PartialEq, sqlx::FromRow)]
struct ProductImage {
    image_id: Uuid,
    object_key: String,
    cutout_object_key: Option<String>,
    bbox: Option<Vec<f32>>,
    source: String,
}

async fn references(
    conn: &mut PgConnection,
    job: &ClaimedJob,
) -> Result<Vec<ProductImage>, sqlx::Error> {
    sqlx::query_as(
        "SELECT pi.image_id, i.object_key, ci.object_key AS cutout_object_key, pi.bbox, pi.source
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
    augmentation: &'static str,
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
    augment: bool,
) -> anyhow::Result<()> {
    let images = references(&mut *pool.acquire().await?, job).await?;
    let model = embedder.model().to_owned();
    let mut embeddings = Vec::with_capacity(images.len() * 2);
    if images
        .first()
        .is_some_and(|image| image.source == "keyframe")
    {
        let mut originals = Vec::with_capacity(images.len());
        for image in &images {
            let bbox = image
                .bbox
                .as_deref()
                .map(<[f32; 4]>::try_from)
                .transpose()
                .context("invalid reference bbox")?;
            let vector = embed_image(
                embedder.clone(),
                slots.clone(),
                storage.get(&image.object_key).await?,
                bbox,
                false,
                false,
            )
            .await?
            .remove(0)
            .1;
            originals.push(vector);
        }
        let keep = std::env::var("KEYFRAME_KEEP")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (1..=KEYFRAME_KEEP).contains(value))
            .unwrap_or(KEYFRAME_KEEP);
        for index in farthest_points(&originals, keep) {
            let image = &images[index];
            embeddings.push(Embedding {
                image_id: image.image_id,
                kind: "crop",
                augmentation: "original",
                vector: originals[index].clone(),
            });
            if augment {
                let bbox = image
                    .bbox
                    .as_deref()
                    .map(<[f32; 4]>::try_from)
                    .transpose()
                    .context("invalid reference bbox")?;
                for (augmentation, vector) in embed_image(
                    embedder.clone(),
                    slots.clone(),
                    storage.get(&image.object_key).await?,
                    bbox,
                    true,
                    true,
                )
                .await?
                {
                    embeddings.push(Embedding {
                        image_id: image.image_id,
                        kind: "crop",
                        augmentation,
                        vector,
                    });
                }
            }
        }
    } else {
        for image in &images {
            let bbox = image
                .bbox
                .as_deref()
                .map(<[f32; 4]>::try_from)
                .transpose()
                .context("invalid reference bbox")?;
            let bytes = storage.get(&image.object_key).await?;
            for (augmentation, vector) in
                embed_image(embedder.clone(), slots.clone(), bytes, bbox, augment, false).await?
            {
                embeddings.push(Embedding {
                    image_id: image.image_id,
                    kind: "crop",
                    augmentation,
                    vector,
                });
            }
            if let Some(key) = &image.cutout_object_key {
                for (augmentation, vector) in embed_image(
                    embedder.clone(),
                    slots.clone(),
                    storage.get(key).await?,
                    None,
                    augment,
                    false,
                )
                .await?
                {
                    embeddings.push(Embedding {
                        image_id: image.image_id,
                        kind: "cutout",
                        augmentation,
                        vector,
                    });
                }
            }
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
    // Replace the complete view set atomically: prune removed photos, disabled variants,
    // and incompatible model identities without leaving stale rows in HNSW.
    sqlx::query("DELETE FROM product_embeddings WHERE product_id=$1 AND store_id=$2")
        .bind(job.product_id)
        .bind(job.store_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM product_prototypes WHERE product_id=$1 AND store_id=$2 AND model<>$3")
        .bind(job.product_id)
        .bind(job.store_id)
        .bind(&model)
        .execute(&mut *tx)
        .await?;
    for embedding in &embeddings {
        sqlx::query(
            "INSERT INTO product_embeddings (store_id, product_id, image_id, model, kind, augmentation, embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7::vector)",
        ).bind(job.store_id).bind(job.product_id).bind(embedding.image_id).bind(&model)
            .bind(embedding.kind).bind(embedding.augmentation).bind(vector_text(&embedding.vector)).execute(&mut *tx).await?;
    }
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
    augment: bool,
    keyframe_extras: bool,
) -> anyhow::Result<Vec<(&'static str, Vec<f32>)>> {
    let permit = slots.acquire_owned().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let decoded = crop::decode_limited(&bytes)
            .map_err(anyhow::Error::msg)?
            .into_rgb8();
        let cropped = if let Some(bbox) = bbox {
            crop::crop_with_padding(&decoded, bbox, CROP_PADDING).context("empty bbox crop")?
        } else {
            decoded
        };
        let (names, crops): (Vec<_>, Vec<_>) = crop::index_augmentations(&cropped, augment)
            .into_iter()
            .filter(|(name, _)| {
                !keyframe_extras || matches!(*name, "rotate90" | "rotate270" | "far48")
            })
            .unzip();
        let vectors = embedder.embed_crops(&crops)?;
        ensure!(
            vectors.len() == names.len(),
            "invalid embedding batch length"
        );
        for vector in &vectors {
            ensure!(
                vector.len() == 384 && vector.len() == embedder.dim(),
                "invalid embedding dimension"
            );
            ensure!(vector.iter().all(|v| v.is_finite()), "non-finite embedding");
        }
        Ok(names.into_iter().zip(vectors).collect())
    })
    .await?
}

/// Stable ties favor the earliest frame in capture order.
fn farthest_points(vectors: &[Vec<f32>], keep: usize) -> Vec<usize> {
    if vectors.is_empty() || keep == 0 {
        return Vec::new();
    }
    let mut mean = vec![0.0_f64; vectors[0].len()];
    for vector in vectors {
        for (sum, value) in mean.iter_mut().zip(vector) {
            *sum += f64::from(*value) / vectors.len() as f64;
        }
    }
    let distance = |a: &[f32], b: &[f32]| -> f64 {
        a.iter()
            .zip(b)
            .map(|(x, y)| (f64::from(*x) - f64::from(*y)).powi(2))
            .sum()
    };
    let first = (0..vectors.len())
        .min_by(|&a, &b| {
            let d = |i: usize| {
                vectors[i]
                    .iter()
                    .zip(&mean)
                    .map(|(x, y)| (f64::from(*x) - y).powi(2))
                    .sum::<f64>()
            };
            d(a).total_cmp(&d(b)).then(a.cmp(&b))
        })
        .unwrap();
    let mut selected = vec![first];
    while selected.len() < keep.min(vectors.len()) {
        let next = (0..vectors.len())
            .filter(|i| !selected.contains(i))
            .max_by(|&a, &b| {
                let d = |i: usize| {
                    selected
                        .iter()
                        .map(|&j| distance(&vectors[i], &vectors[j]))
                        .fold(f64::INFINITY, f64::min)
                };
                d(a).total_cmp(&d(b)).then(b.cmp(&a))
            })
            .unwrap();
        selected.push(next);
    }
    selected
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

#[cfg(test)]
mod keyframe_tests {
    use super::*;

    #[test]
    fn prototype_keeps_all_768_dimensions() {
        let mut vector = vec![0.; 768];
        vector[767] = 1.;
        let result = compute_prototype(&[Embedding {
            image_id: Uuid::nil(),
            kind: "crop",
            augmentation: "original",
            vector,
        }])
        .unwrap();
        assert_eq!(result.len(), 768);
        assert_eq!(result[767], 1.);
    }

    #[test]
    fn selection_starts_near_mean_and_spreads_deterministically() {
        let vectors = vec![vec![0.0], vec![1.0], vec![2.0], vec![10.0], vec![-10.0]];
        assert_eq!(farthest_points(&vectors, 3), vec![1, 4, 3]);
        assert_eq!(farthest_points(&vectors, 3), farthest_points(&vectors, 3));
    }
}
