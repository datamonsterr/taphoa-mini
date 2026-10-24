//! Integration tests for the background index job worker (task B5).
//!
//! Requires: `DATABASE_URL=postgres://taphoa:taphoa@127.0.0.1:55501/qe_b5`
//!
//! Run with:
//!   DATABASE_URL=postgres://taphoa:taphoa@127.0.0.1:55501/qe_b5 \
//!   cargo test -p taphoa-api --test index_jobs -- --include-ignored
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use sqlx::{PgPool, postgres::PgPoolOptions};
use taphoa_api::{
    MIGRATOR,
    catalog::index_jobs::{WorkerConfig, enqueue, process_next, spawn},
    storage::{ObjectStore, SignedUrl},
};
use taphoa_recognition::{EmbedError, Embedder, MockEmbedder};
use uuid::Uuid;

// ─── Serial execution guard ───────────────────────────────────────────────────

/// Prevent parallel test execution to avoid FK conflicts on the shared database.
async fn serial_guard() -> tokio::sync::OwnedMutexGuard<()> {
    static LOCK: std::sync::OnceLock<Arc<tokio::sync::Mutex<()>>> = std::sync::OnceLock::new();
    let lock = LOCK.get_or_init(Default::default).clone();
    lock.lock_owned().await
}

fn test_config() -> WorkerConfig {
    WorkerConfig {
        poll_interval: Duration::from_millis(50),
        backoff_base: Duration::from_millis(100),
        ..WorkerConfig::default()
    }
}

// ─── Test infrastructure ──────────────────────────────────────────────────────

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect");
    MIGRATOR.run(&pool).await.expect("migrate");
    pool
}

// ── In-memory object store ────────────────────────────────────────────────────

#[derive(Default)]
struct MemStore {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    fail: AtomicBool,
}

#[async_trait]
impl ObjectStore for MemStore {
    async fn put(&self, key: &str, _: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        self.objects.lock().unwrap().insert(key.into(), bytes);
        Ok(())
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.objects.lock().unwrap().remove(key);
        Ok(())
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        Ok(SignedUrl {
            url: format!("https://fake.test/{key}"),
            expires_at: (SystemTime::now() + ttl).into(),
        })
    }
    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        if self.fail.load(Ordering::Relaxed) {
            anyhow::bail!("fake storage failure");
        }
        self.objects
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("object {key} not found"))
    }
}

// ── Failing embedder ──────────────────────────────────────────────────────────

struct FailEmbedder;
impl Embedder for FailEmbedder {
    fn model(&self) -> &str {
        "fail-embedder@1"
    }
    fn dim(&self) -> usize {
        384
    }
    fn embed(&self, _image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        Err(EmbedError::Inference("deliberate test failure".into()))
    }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/// Minimal PNG (2×2 pixels) so the embedder can decode it.
fn tiny_png() -> Vec<u8> {
    use image::RgbImage;
    let mut bytes = Vec::new();
    RgbImage::new(2, 2)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

async fn new_store(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id, name, recovery_code_hash) VALUES ($1, 'b5-test', 'x')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn new_member(pool: &PgPool, store_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO members (id, store_id, display_name, role) VALUES ($1, $2, 'b5', 'seller')",
    )
    .bind(id)
    .bind(store_id)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn new_product(pool: &PgPool, store_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    let member_id = new_member(pool, store_id).await;
    sqlx::query(
        "INSERT INTO products (id, store_id, price, request_hash, created_by) \
         VALUES ($1, $2, 0, $3, $4)",
    )
    .bind(id)
    .bind(store_id)
    .bind(vec![0u8; 32])
    .bind(member_id)
    .execute(pool)
    .await
    .unwrap();
    id
}

/// Insert an image row and store bytes in the MemStore. Returns image_id.
async fn new_image(pool: &PgPool, store_id: Uuid, store: &MemStore, key: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, store_id, object_key, content_type, byte_size) \
         VALUES ($1, $2, $3, 'image/png', 100)",
    )
    .bind(id)
    .bind(store_id)
    .bind(key)
    .execute(pool)
    .await
    .unwrap();
    store
        .objects
        .lock()
        .unwrap()
        .insert(key.to_string(), tiny_png());
    id
}

/// Attach image to product.
async fn attach_image(pool: &PgPool, product_id: Uuid, image_id: Uuid, position: i16) {
    sqlx::query("INSERT INTO product_images (product_id, image_id, position) VALUES ($1, $2, $3)")
        .bind(product_id)
        .bind(image_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
}

/// Attach image with a cutout stored separately.
async fn attach_image_with_cutout(
    pool: &PgPool,
    store_id: Uuid,
    product_id: Uuid,
    image_id: Uuid,
    position: i16,
    obj_store: &MemStore,
) {
    let cutout_id = Uuid::new_v4();
    let cutout_key = format!("cutout/{cutout_id}.png");
    sqlx::query(
        "INSERT INTO images (id, store_id, object_key, content_type, byte_size) \
         VALUES ($1, $2, $3, 'image/png', 100)",
    )
    .bind(cutout_id)
    .bind(store_id)
    .bind(&cutout_key)
    .execute(pool)
    .await
    .unwrap();
    obj_store
        .objects
        .lock()
        .unwrap()
        .insert(cutout_key.clone(), tiny_png());

    sqlx::query(
        "INSERT INTO product_images (product_id, image_id, position, cutout_image_id) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(product_id)
    .bind(image_id)
    .bind(position)
    .bind(cutout_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn cleanup(pool: &PgPool, store_id: Uuid) {
    sqlx::query("DELETE FROM products WHERE store_id = $1")
        .bind(store_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM stores WHERE id = $1")
        .bind(store_id)
        .execute(pool)
        .await
        .unwrap();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

/// Test 1: happy path — enqueue → process_next → job done, product ready, embeddings + prototype.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn happy_path_job_done_embeddings_and_prototype() {
    let _guard = serial_guard().await;
    let pool = pool().await;

    let storage = Arc::new(MemStore::default());
    let embedder: Arc<dyn Embedder> = Arc::new(MockEmbedder);
    let slots = Arc::new(tokio::sync::Semaphore::new(2));
    let cfg = test_config();

    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;

    let mut reference_ids = Vec::new();
    for position in 0..3 {
        let img_key = format!("img/{}.png", Uuid::new_v4());
        let image_id = new_image(&pool, store_id, &storage, &img_key).await;
        attach_image_with_cutout(&pool, store_id, product_id, image_id, position, &storage).await;
        reference_ids.push(image_id);
    }

    // Enqueue inside a transaction (simulating caller's tx).
    let mut tx = pool.begin().await.unwrap();
    let job_id = enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    // Check index_status = pending.
    let status: String = sqlx::query_scalar("SELECT index_status FROM products WHERE id = $1")
        .bind(product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "pending");

    // Process the job.
    let processed = process_next(&pool, embedder, storage, slots, &cfg)
        .await
        .unwrap();
    assert!(processed, "expected a job to be processed");

    // Job should be done.
    let job_status: String = sqlx::query_scalar("SELECT status FROM index_jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(job_status, "done");

    // Product index_status = ready.
    let prod_status: String = sqlx::query_scalar("SELECT index_status FROM products WHERE id = $1")
        .bind(product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(prod_status, "ready");

    // Two embeddings per reference: 'crop' and 'cutout'.
    let emb_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_embeddings WHERE product_id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(emb_count, 6, "expected crop + cutout per reference");
    let source_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT image_id FROM product_embeddings WHERE product_id=$1")
            .bind(product_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(source_ids.iter().all(|id| reference_ids.contains(id)));

    let kinds: Vec<String> = sqlx::query_scalar(
        "SELECT kind FROM product_embeddings WHERE product_id = $1 ORDER BY kind",
    )
    .bind(product_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(kinds.contains(&"crop".to_string()));
    assert!(kinds.contains(&"cutout".to_string()));

    // Prototype row counts references, rather than embedding views.
    let ref_count: i32 =
        sqlx::query_scalar("SELECT reference_count FROM product_prototypes WHERE product_id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ref_count, 3);

    // Outbox contains product.indexed with status ready.
    let payload: serde_json::Value = sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE store_id = $1 AND type = 'product.indexed' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(store_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(payload["data"]["index_status"], "ready");
    assert_eq!(payload["data"]["product_id"], product_id.to_string());
    assert_eq!(payload["data"]["reference_count"], 3);
    assert_eq!(payload["version"], 1);
    assert!(payload["actor"].is_null());

    cleanup(&pool, store_id).await;
}

/// Test 2: rerunning the same job is idempotent — same embedding count, prototype updated.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn rerun_is_idempotent() {
    let _guard = serial_guard().await;
    let pool = pool().await;

    let storage = Arc::new(MemStore::default());
    let embedder: Arc<dyn Embedder> = Arc::new(MockEmbedder);
    let slots = Arc::new(tokio::sync::Semaphore::new(2));
    let cfg = test_config();

    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;

    let img_key = format!("img/{}.png", Uuid::new_v4());
    let image_id = new_image(&pool, store_id, &storage, &img_key).await;
    attach_image(&pool, product_id, image_id, 0).await;

    // First run.
    let mut tx = pool.begin().await.unwrap();
    enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    process_next(
        &pool,
        embedder.clone(),
        storage.clone(),
        slots.clone(),
        &cfg,
    )
    .await
    .unwrap();

    let count1: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_embeddings WHERE product_id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    // Second run.
    let mut tx = pool.begin().await.unwrap();
    enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    process_next(&pool, embedder, storage, slots, &cfg)
        .await
        .unwrap();

    let count2: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_embeddings WHERE product_id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(
        count1, count2,
        "second run must not add duplicate embeddings"
    );

    // Prototype must still exist.
    let proto_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM product_prototypes WHERE product_id = $1)")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(proto_exists);

    cleanup(&pool, store_id).await;
}

/// Test 3: embedder failure → retries with backoff → after 5 attempts → failed.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn embedder_failure_retries_then_failed() {
    let _guard = serial_guard().await;
    let pool = pool().await;

    let storage = Arc::new(MemStore::default());
    let embedder: Arc<dyn Embedder> = Arc::new(FailEmbedder);
    let slots = Arc::new(tokio::sync::Semaphore::new(2));
    let cfg = test_config();

    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;

    let img_key = format!("img/{}.png", Uuid::new_v4());
    let image_id = new_image(&pool, store_id, &storage, &img_key).await;
    attach_image(&pool, product_id, image_id, 0).await;

    let mut tx = pool.begin().await.unwrap();
    let job_id = enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    // Run MAX_ATTEMPTS=5 times; reset run_after each time for immediate eligibility.
    for attempt in 0..5i32 {
        // Reset run_after so the job is eligible immediately.
        sqlx::query("UPDATE index_jobs SET run_after = now() WHERE id = $1")
            .bind(job_id)
            .execute(&pool)
            .await
            .unwrap();

        let processed = process_next(
            &pool,
            embedder.clone(),
            storage.clone(),
            slots.clone(),
            &cfg,
        )
        .await
        .unwrap();
        assert!(processed, "attempt {attempt}: expected job to be processed");

        // After attempt 4 (attempts col will be 5 = MAX_ATTEMPTS), the job is failed.
        if attempt == 4 {
            break;
        }
        // Otherwise job should be queued again.
        let status: String = sqlx::query_scalar("SELECT status FROM index_jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            status, "queued",
            "after attempt {attempt}: should be requeued"
        );
        let (attempts, delay, error): (i32, f64, Option<String>) = sqlx::query_as(
            "SELECT attempts, extract(epoch FROM run_after - updated_at)::float8, last_error FROM index_jobs WHERE id=$1",
        ).bind(job_id).fetch_one(&pool).await.unwrap();
        assert_eq!(attempts, attempt + 1);
        assert!(error.unwrap().contains("deliberate test failure"));
        assert!(
            (delay - cfg.backoff_base.as_secs_f64() * 2f64.powi(attempt + 1)).abs() < 0.0001,
            "delay = {delay}"
        );
        assert!(
            !process_next(
                &pool,
                embedder.clone(),
                storage.clone(),
                slots.clone(),
                &cfg
            )
            .await
            .unwrap(),
            "backoff must prevent immediate retry"
        );
    }

    // After 5 attempts the job must be 'failed'.
    let job_status: String = sqlx::query_scalar("SELECT status FROM index_jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(job_status, "failed");

    // Product index_status must be 'failed'.
    let prod_status: String = sqlx::query_scalar("SELECT index_status FROM products WHERE id = $1")
        .bind(product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(prod_status, "failed");

    // Outbox must have product.indexed with failed status.
    let payload: serde_json::Value = sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE store_id = $1 AND type = 'product.indexed' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(store_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(payload["data"]["index_status"], "failed");
    assert_eq!(payload["data"]["reference_count"], 1);
    let (attempts, embeddings, prototypes, ready_events): (i32, i64, i64, i64) = sqlx::query_as(
        "SELECT attempts,
          (SELECT count(*) FROM product_embeddings WHERE product_id=$2),
          (SELECT count(*) FROM product_prototypes WHERE product_id=$2),
          (SELECT count(*) FROM outbox_events WHERE store_id=$3 AND payload->'data'->>'index_status'='ready')
         FROM index_jobs WHERE id=$1",
    ).bind(job_id).bind(product_id).bind(store_id).fetch_one(&pool).await.unwrap();
    assert_eq!(
        (attempts, embeddings, prototypes, ready_events),
        (5, 0, 0, 0)
    );

    cleanup(&pool, store_id).await;
}

/// Test 4: shutdown — sending `true` on the watch channel stops the worker within 2 s.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn shutdown_stops_worker_promptly() {
    let _guard = serial_guard().await;
    let pool = pool().await;
    let store_id = new_store(&pool).await;
    let product = new_product(&pool, store_id).await;
    let storage = Arc::new(MemStore::default());
    let image = new_image(
        &pool,
        store_id,
        &storage,
        &format!("img/{}", Uuid::new_v4()),
    )
    .await;
    attach_image(&pool, product, image, 0).await;
    let mut tx = pool.begin().await.unwrap();
    let job = enqueue(&mut tx, store_id, product).await.unwrap();
    tx.commit().await.unwrap();
    // Block inference so shutdown must cancel active processing, not just an idle timer.
    let slots = Arc::new(tokio::sync::Semaphore::new(0));
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let handle = spawn(
        pool.clone(),
        Arc::new(MockEmbedder),
        storage,
        slots,
        stop_rx,
        test_config(),
    );
    wait_running(&pool, job).await;
    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("worker must stop within 2 s")
        .expect("worker panicked");
    cleanup(&pool, store_id).await;
}

/// Test 5: shutdown when initially stopped — should exit immediately.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn shutdown_when_already_stopped() {
    let _guard = serial_guard().await;
    let pool = pool().await;

    let storage: Arc<dyn ObjectStore> = Arc::new(MemStore::default());
    let embedder: Arc<dyn Embedder> = Arc::new(MockEmbedder);
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let cfg = test_config();

    let (_stop_tx, stop_rx) = tokio::sync::watch::channel(true); // already stopped

    let handle = spawn(pool, embedder, storage, slots, stop_rx, cfg);

    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("worker must stop within 2 s when pre-stopped")
        .expect("worker panicked");
}

/// Test 6: enqueue twice for the same product reuses the existing queued job.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn enqueue_twice_reuses_queued_job() {
    let _guard = serial_guard().await;
    let pool = pool().await;

    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;

    let mut tx = pool.begin().await.unwrap();
    let id1 = enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = pool.begin().await.unwrap();
    let id2 = enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    assert_eq!(id1, id2, "second enqueue must reuse existing queued job");

    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM index_jobs WHERE product_id = $1 AND status = 'queued'",
    )
    .bind(product_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);

    cleanup(&pool, store_id).await;
}

/// Test 7: LISTEN wake-up — spawn the worker with no initial jobs, enqueue one, worker picks it up.
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn worker_wakes_on_notify() {
    let _guard = serial_guard().await;
    let pool = pool().await;

    let storage_mem = Arc::new(MemStore::default());
    let embedder: Arc<dyn Embedder> = Arc::new(MockEmbedder);
    let slots = Arc::new(tokio::sync::Semaphore::new(2));
    let cfg = WorkerConfig {
        poll_interval: Duration::from_secs(30),
        ..test_config()
    };

    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;
    let img_key = format!("img/{}.png", Uuid::new_v4());
    let image_id = new_image(&pool, store_id, &storage_mem, &img_key).await;
    attach_image(&pool, product_id, image_id, 0).await;

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let handle = spawn(
        pool.clone(),
        embedder,
        storage_mem as Arc<dyn ObjectStore>,
        slots,
        stop_rx,
        cfg,
    );

    // Prove LISTEN is active before enqueue; 30 s polling cannot satisfy the 5 s deadline.
    let listen_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let listening: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN%index_jobs%' AND state='idle')",
        ).fetch_one(&pool).await.unwrap();
        if listening {
            break;
        }
        assert!(
            tokio::time::Instant::now() < listen_deadline,
            "worker never LISTENed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Enqueue a job (NOTIFY fires on commit, waking the LISTEN'd worker).
    let mut tx = pool.begin().await.unwrap();
    enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();

    // Wait for the worker to process the job (up to 5 s).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let status: String = sqlx::query_scalar("SELECT index_status FROM products WHERE id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        if status == "ready" {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("worker did not process job within 5 s; index_status = {status}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("worker stop")
        .unwrap();

    cleanup(&pool, store_id).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn concurrent_enqueue_serializes_and_transaction_rollback_is_atomic() {
    let _guard = serial_guard().await;
    let pool = pool().await;
    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;
    let mut rolled_back = pool.begin().await.unwrap();
    enqueue(&mut rolled_back, store_id, product_id)
        .await
        .unwrap();
    rolled_back.rollback().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT index_status FROM products WHERE id=$1")
        .bind(product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "ready");
    let mut first = pool.begin().await.unwrap();
    let job_id = enqueue(&mut first, store_id, product_id).await.unwrap();
    let other_pool = pool.clone();
    let second = tokio::spawn(async move {
        let mut tx = other_pool.begin().await.unwrap();
        let id = enqueue(&mut tx, store_id, product_id).await.unwrap();
        tx.commit().await.unwrap();
        id
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    first.commit().await.unwrap();
    assert_eq!(second.await.unwrap(), job_id);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM index_jobs WHERE product_id=$1")
        .bind(product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let wrong_store = new_store(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    assert!(enqueue(&mut tx, wrong_store, product_id).await.is_err());
    tx.rollback().await.unwrap();
    cleanup(&pool, store_id).await;
    cleanup(&pool, wrong_store).await;
}

#[derive(Default)]
struct RecordingEmbedder(Mutex<Vec<Vec<u8>>>);
impl Embedder for RecordingEmbedder {
    fn model(&self) -> &str {
        MockEmbedder.model()
    }
    fn dim(&self) -> usize {
        384
    }
    fn embed(&self, bytes: &[u8]) -> Result<Vec<f32>, EmbedError> {
        self.0.lock().unwrap().push(bytes.to_vec());
        MockEmbedder.embed(bytes)
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn bbox_legacy_prototype_and_removed_references() {
    let _guard = serial_guard().await;
    let pool = pool().await;
    let store_id = new_store(&pool).await;
    let product_id = new_product(&pool, store_id).await;
    let storage = Arc::new(MemStore::default());
    let embedder = Arc::new(RecordingEmbedder::default());
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let cfg = test_config();
    let image_id = new_image(
        &pool,
        store_id,
        &storage,
        &format!("img/{}", Uuid::new_v4()),
    )
    .await;
    attach_image_with_cutout(&pool, store_id, product_id, image_id, 0, &storage).await;
    let original = image::RgbImage::from_fn(40, 32, |x, y| image::Rgb([x as u8, y as u8, 99]));
    let mut bytes = Vec::new();
    original
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    let key: String = sqlx::query_scalar("SELECT object_key FROM images WHERE id=$1")
        .bind(image_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    storage.put(&key, "image/png", bytes).await.unwrap();
    sqlx::query("UPDATE product_images SET bbox=ARRAY[8,8,8,8]::real[] WHERE image_id=$1")
        .bind(image_id)
        .execute(&pool)
        .await
        .unwrap();
    let legacy = new_image(
        &pool,
        store_id,
        &storage,
        &format!("img/{}", Uuid::new_v4()),
    )
    .await;
    attach_image(&pool, product_id, legacy, 1).await;
    let mut tx = pool.begin().await.unwrap();
    let job_id = enqueue(&mut tx, store_id, product_id).await.unwrap();
    tx.commit().await.unwrap();
    // A crashed running job is recoverable by the deterministic entry point too.
    sqlx::query("UPDATE index_jobs SET status='running', updated_at=now()-interval '11 minutes' WHERE id=$1")
        .bind(job_id).execute(&pool).await.unwrap();
    assert!(
        process_next(
            &pool,
            embedder.clone(),
            storage.clone(),
            slots.clone(),
            &cfg
        )
        .await
        .unwrap()
    );
    let captured = embedder.0.lock().unwrap().clone();
    assert_eq!(captured.len(), 3);
    let expected_crop =
        taphoa_recognition::crop::crop_with_padding(&original, [8., 8., 8., 8.], 0.08).unwrap();
    assert!(
        captured
            .iter()
            .any(|b| image::load_from_memory(b).unwrap().into_rgb8() == expected_crop)
    );
    assert_eq!(
        captured
            .iter()
            .filter(|b| image::load_from_memory(b).unwrap().width() == 2)
            .count(),
        2,
        "stored cutout and legacy whole image"
    );
    let (prototype, reference_count): (pgvector::Vector, i32) = sqlx::query_as(
        "SELECT embedding, reference_count FROM product_prototypes WHERE product_id=$1",
    )
    .bind(product_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reference_count, 2);
    let mut mean = vec![0f32; 384];
    for bytes in &captured {
        for (sum, value) in mean.iter_mut().zip(MockEmbedder.embed(bytes).unwrap()) {
            *sum += value;
        }
    }
    taphoa_recognition::crop::l2_normalize(&mut mean);
    assert!(
        mean.iter()
            .zip(prototype.as_slice())
            .all(|(a, b)| (a - b).abs() < 1e-5)
    );
    // Removing a cutout and a reference prunes their embeddings, then removing all refs prunes the prototype.
    sqlx::query("UPDATE product_images SET cutout_image_id=NULL WHERE image_id=$1")
        .bind(image_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM product_images WHERE image_id=$1")
        .bind(legacy)
        .execute(&pool)
        .await
        .unwrap();
    for expected in [1i64, 0] {
        if expected == 0 {
            sqlx::query("DELETE FROM product_images WHERE product_id=$1")
                .bind(product_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut tx = pool.begin().await.unwrap();
        enqueue(&mut tx, store_id, product_id).await.unwrap();
        tx.commit().await.unwrap();
        assert!(
            process_next(
                &pool,
                embedder.clone(),
                storage.clone(),
                slots.clone(),
                &cfg
            )
            .await
            .unwrap()
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM product_embeddings WHERE product_id=$1")
                .bind(product_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, expected);
    }
    let prototypes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_prototypes WHERE product_id=$1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(prototypes, 0);
    cleanup(&pool, store_id).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn skips_locked_and_future_jobs_and_caps_backoff() {
    let _guard = serial_guard().await;
    let pool = pool().await;
    let store_id = new_store(&pool).await;
    let storage = Arc::new(MemStore::default());
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let cfg = WorkerConfig {
        backoff_base: Duration::MAX,
        ..test_config()
    };
    let mut jobs = Vec::new();
    for _ in 0..2 {
        let product = new_product(&pool, store_id).await;
        let image = new_image(
            &pool,
            store_id,
            &storage,
            &format!("img/{}", Uuid::new_v4()),
        )
        .await;
        attach_image(&pool, product, image, 0).await;
        let mut tx = pool.begin().await.unwrap();
        jobs.push(enqueue(&mut tx, store_id, product).await.unwrap());
        tx.commit().await.unwrap();
    }
    sqlx::query("UPDATE index_jobs SET run_after=now()+interval '1 hour' WHERE id=$1")
        .bind(jobs[1])
        .execute(&pool)
        .await
        .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM index_jobs WHERE id=$1 FOR UPDATE")
        .bind(jobs[0])
        .execute(&mut *held)
        .await
        .unwrap();
    assert!(
        !tokio::time::timeout(
            Duration::from_secs(1),
            process_next(
                &pool,
                Arc::new(MockEmbedder),
                storage.clone(),
                slots.clone(),
                &cfg
            )
        )
        .await
        .expect("SKIP LOCKED must not wait")
        .unwrap()
    );
    held.rollback().await.unwrap();
    assert!(
        process_next(&pool, Arc::new(FailEmbedder), storage, slots, &cfg)
            .await
            .unwrap()
    );
    let delay: f64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM run_after-updated_at)::float8 FROM index_jobs WHERE id=$1",
    )
    .bind(jobs[0])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(delay, 300.0);
    cleanup(&pool, store_id).await;
}

async fn wait_running(pool: &PgPool, job: Uuid) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let status: String = sqlx::query_scalar("SELECT status FROM index_jobs WHERE id=$1")
            .bind(job)
            .fetch_one(pool)
            .await
            .unwrap();
        if status == "running" {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "job was never claimed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn reclaimed_lease_fences_old_success_and_failure() {
    let _guard = serial_guard().await;
    let pool = pool().await;
    let store_id = new_store(&pool).await;
    let storage = Arc::new(MemStore::default());
    let cfg = test_config();
    for fail in [false, true] {
        let product = new_product(&pool, store_id).await;
        let image = new_image(
            &pool,
            store_id,
            &storage,
            &format!("img/{}", Uuid::new_v4()),
        )
        .await;
        attach_image(&pool, product, image, 0).await;
        let mut tx = pool.begin().await.unwrap();
        let job = enqueue(&mut tx, store_id, product).await.unwrap();
        tx.commit().await.unwrap();
        let blocked_slots = Arc::new(tokio::sync::Semaphore::new(0));
        let old = {
            let pool = pool.clone();
            let storage = storage.clone();
            let slots = blocked_slots.clone();
            let cfg = cfg.clone();
            tokio::spawn(async move {
                let embedder: Arc<dyn Embedder> = if fail {
                    Arc::new(FailEmbedder)
                } else {
                    Arc::new(MockEmbedder)
                };
                process_next(&pool, embedder, storage, slots, &cfg).await
            })
        };
        wait_running(&pool, job).await;
        sqlx::query("UPDATE index_jobs SET updated_at=now()-interval '11 minutes' WHERE id=$1")
            .bind(job)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            process_next(
                &pool,
                Arc::new(MockEmbedder),
                storage.clone(),
                Arc::new(tokio::sync::Semaphore::new(1)),
                &cfg
            )
            .await
            .unwrap()
        );
        blocked_slots.add_permits(1);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), old)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
        );
        let result: (String, i32, Option<String>) =
            sqlx::query_as("SELECT status, attempts, last_error FROM index_jobs WHERE id=$1")
                .bind(job)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(result, ("done".into(), 2, None));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type='product.indexed' AND payload->'data'->>'product_id'=$2")
            .bind(store_id).bind(product.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1, "stale workers must not publish or change status");
    }
    cleanup(&pool, store_id).await;
}
