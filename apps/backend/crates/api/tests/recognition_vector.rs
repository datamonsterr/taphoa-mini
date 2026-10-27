//! Integration tests for the pgvector adapter of `VectorIndex` (architecture §5.3).
//! Requires Postgres with pgvector. Run with DATABASE_URL set:
//! `DATABASE_URL=... cargo test -p taphoa-api --test recognition_vector -- --ignored --test-threads=1`
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use taphoa_api::recognition::pgvector::PgVectorIndex;
use taphoa_api::vector::{InMemoryVectorIndex, VectorIndex};
use uuid::Uuid;

const MODEL: &str = "dinov2-vits14-onnx@1";
const OTHER_MODEL: &str = "clip-vit-b32-onnx@1";
const DIM: usize = 384;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok().or_else(|| {
        eprintln!("SKIP recognition_vector: set DATABASE_URL");
        None
    })?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    taphoa_api::MIGRATOR.run(&pool).await.unwrap();
    Some(pool)
}

/// Serializes the tests and deletes the stores they created (name 't') afterwards, so rows with
/// unnormalized test vectors do not leak into suites that assert global invariants.
struct Tidy {
    _serial: tokio::sync::OwnedMutexGuard<()>,
}
impl Tidy {
    async fn start(_pool: PgPool) -> Self {
        static SERIAL: std::sync::OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
            std::sync::OnceLock::new();
        let lock = SERIAL.get_or_init(Default::default).clone();
        Self {
            _serial: lock.lock_owned().await,
        }
    }
}
impl Drop for Tidy {
    fn drop(&mut self) {
        // The test's runtime is shutting down; clean up from a scratch thread and runtime.
        let _ = std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(async {
                    // A pool of the blocked test runtime cannot make progress: connect anew.
                    let Ok(url) = std::env::var("DATABASE_URL") else {
                        return;
                    };
                    if let Ok(fresh) = PgPoolOptions::new().max_connections(1).connect(&url).await {
                        let _ = sqlx::query("DELETE FROM stores WHERE name = 't'")
                            .execute(&fresh)
                            .await;
                    }
                });
            }
        })
        .join();
    }
}

async fn new_store(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id, name) VALUES ($1, 't')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn new_member(pool: &PgPool, store_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO members (clerk_user_id,id, store_id, display_name, role) VALUES ('fixture_' || gen_random_uuid()::text,$1, $2, 'a', 'seller')",
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
    sqlx::query(
        "INSERT INTO products (id, store_id, price, request_hash, created_by)
         VALUES ($1, $2, 0, $3, $4)",
    )
    .bind(id)
    .bind(store_id)
    .bind(vec![0u8; 32])
    .bind(new_member(pool, store_id).await)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn new_image(pool: &PgPool, store_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, store_id, object_key, content_type, byte_size)
         VALUES ($1, $2, $3, 'image/jpeg', 4096)",
    )
    .bind(id)
    .bind(store_id)
    .bind(format!("test/{id}.jpg"))
    .execute(pool)
    .await
    .unwrap();
    id
}

/// Canonical basis vector with a single 1: distinct axes are exactly orthogonal.
fn axis(at: usize) -> Vec<f32> {
    let mut vector = vec![0.; DIM];
    vector[at] = 1.;
    vector
}

fn scaled(multiplier: f32, mut vector: Vec<f32>) -> Vec<f32> {
    vector.iter_mut().for_each(|x| *x *= multiplier);
    vector
}

fn best_similarity(query: &[f32], vector: &[f32]) -> f32 {
    let dot: f64 = query
        .iter()
        .zip(vector)
        .map(|(&a, &b)| f64::from(a) * f64::from(b))
        .sum();
    let a: f64 = query
        .iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt();
    let b: f64 = vector
        .iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt();
    ((dot / (a * b)) as f32).clamp(-1., 1.)
}

struct Prng(u64);
impl Prng {
    fn new(key: &str) -> Self {
        Self(u64::from_le_bytes(
            Sha256::digest(key.as_bytes())[..8].try_into().unwrap(),
        ))
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut n = self.0;
        n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111ef);
        n ^ (n >> 31)
    }
}

/// Deterministic lattice vectors keep the index data reproducible run to run.
fn random_vector(rng: &mut Prng) -> Vec<f32> {
    let vector: Vec<f32> = (0..DIM)
        .map(|_| (rng.next() % 4001) as f32 / 1000. - 2.)
        .collect();
    let norm = vector
        .iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt();
    if norm > 0. { vector } else { axis(0) }
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn best_per_product_limit_and_store_or_model_isolation() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let store = new_store(&pool).await;
    let other = new_store(&pool).await;
    let (p1, p2, p3) = (
        new_product(&pool, store).await,
        new_product(&pool, store).await,
        new_product(&pool, other).await,
    );
    index
        .upsert(
            store,
            p1,
            new_image(&pool, store).await,
            MODEL,
            axis(DIM - 1),
        )
        .await
        .unwrap();
    index
        .upsert(
            store,
            p1,
            new_image(&pool, store).await,
            MODEL,
            scaled(4., axis(0)),
        )
        .await
        .unwrap();
    let mixed: Vec<f32> = axis(0).iter().zip(axis(1)).map(|(a, b)| a + b).collect();
    index
        .upsert(store, p2, new_image(&pool, store).await, MODEL, mixed)
        .await
        .unwrap();
    index
        .upsert(other, p3, new_image(&pool, other).await, MODEL, axis(0))
        .await
        .unwrap();
    index
        .upsert(
            store,
            p2,
            new_image(&pool, store).await,
            OTHER_MODEL,
            axis(0),
        )
        .await
        .unwrap();

    let query = scaled(2., axis(0));
    let hits = index.search(store, MODEL, &query, 10).await.unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].product_id, p1);
    assert_eq!(hits[0].similarity, 1.);
    assert!(
        (hits[1].similarity - 0.70710677).abs() < 1e-6,
        "p2: {}",
        hits[1].similarity
    );
    assert_eq!(
        index.search(store, MODEL, &query, 1).await.unwrap().len(),
        1
    );

    // Store isolation: the other store only sees its own product.
    let other_hits = index.search(other, MODEL, &axis(0), 10).await.unwrap();
    assert_eq!(other_hits.len(), 1);
    assert_eq!(other_hits[0].product_id, p3);
    assert_eq!(other_hits[0].similarity, 1.);

    // Model isolation within one store after removing p1 and p2.
    index.remove_product(store, p1).await.unwrap();
    assert_eq!(
        index
            .search(store, MODEL, &axis(0), 10)
            .await
            .unwrap()
            .len(),
        1
    );
    index.remove_product(store, p2).await.unwrap();
    let after = index.search(store, MODEL, &axis(0), 10).await.unwrap();
    assert_eq!(after.len(), 0, "removed products still hit: {after:?}");
    let other_model = index
        .search(store, OTHER_MODEL, &axis(0), 10)
        .await
        .unwrap();
    assert_eq!(
        other_model.len(),
        0,
        "removed rows leak across models: {other_model:?}"
    );
    assert_eq!(
        index
            .search(other, MODEL, &axis(0), 10)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn upsert_same_reference_key_replaces_instead_of_duplicating() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let store = new_store(&pool).await;
    let product = new_product(&pool, store).await;
    let image = new_image(&pool, store).await;
    index
        .upsert(store, product, image, MODEL, axis(0))
        .await
        .unwrap();
    index
        .upsert(store, product, image, MODEL, scaled(2., axis(1)))
        .await
        .unwrap();

    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_embeddings
         WHERE store_id = $1 AND product_id = $2 AND image_id = $3 AND model = $4",
    )
    .bind(store)
    .bind(product)
    .bind(image)
    .bind(MODEL)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 1, "same key inserted twice");
    let hits = index
        .search(store, MODEL, &scaled(2., axis(1)), 10)
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].similarity, 1., "old embedding must be replaced");
    // The old axis-0 vector is gone: the only row left is orthogonal to it.
    let orthogonal = index.search(store, MODEL, &axis(0), 10).await.unwrap();
    assert_eq!(orthogonal.len(), 1);
    assert!(orthogonal[0].similarity.abs() < 1e-6);
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn remove_product_deletes_every_model_and_image_row() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let store = new_store(&pool).await;
    let product = new_product(&pool, store).await;
    let survivor = new_product(&pool, store).await;
    for (product_id, model, vector) in [
        (product, MODEL, axis(0)),
        (product, OTHER_MODEL, axis(1)),
        (survivor, MODEL, axis(2)),
    ] {
        index
            .upsert(
                store,
                product_id,
                new_image(&pool, store).await,
                model,
                vector,
            )
            .await
            .unwrap();
    }
    index.remove_product(store, product).await.unwrap();
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_embeddings WHERE product_id = $1")
            .bind(product)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 0);
    let hits = index.search(store, MODEL, &axis(2), 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].product_id, survivor);
    index.remove_product(store, survivor).await.unwrap();
    assert_eq!(
        index
            .search(store, MODEL, &axis(2), 10)
            .await
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn equal_similarities_tie_break_by_product_id_ascending() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let store = new_store(&pool).await;
    let (a, b) = (
        new_product(&pool, store).await,
        new_product(&pool, store).await,
    );
    for product in [a, b] {
        index
            .upsert(
                store,
                product,
                new_image(&pool, store).await,
                MODEL,
                axis(0),
            )
            .await
            .unwrap();
    }
    let hits = index.search(store, MODEL, &axis(0), 10).await.unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits[0].similarity == hits[1].similarity && hits[0].similarity == 1.);
    assert!(
        hits[0].product_id < hits[1].product_id,
        "ties must sort by product_id"
    );
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn rejects_invalid_embeddings_and_wrong_dimension() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let store = Uuid::new_v4();
    for vector in [
        vec![],
        vec![0.; DIM],
        vec![f32::NAN; DIM],
        vec![f32::INFINITY; DIM],
    ] {
        assert!(
            index
                .upsert(store, store, store, MODEL, vector.clone())
                .await
                .is_err()
        );
        assert!(index.search(store, MODEL, &vector, 1).await.is_err());
    }
    assert!(
        index
            .upsert(store, store, store, MODEL, vec![0.5; DIM - 1])
            .await
            .is_err()
    );
    assert!(
        index
            .upsert(store, store, store, MODEL, vec![0.5; DIM + 1])
            .await
            .is_err()
    );
    assert!(
        index
            .search(store, MODEL, &[0.5; DIM - 1], 1)
            .await
            .is_err()
    );
    assert!(
        index
            .search(store, MODEL, &[0.5; DIM + 1], 1)
            .await
            .is_err()
    );
    // A valid embedding roundtrips after all rejections.
    let real_store = new_store(&pool).await;
    let product = new_product(&pool, real_store).await;
    let image = new_image(&pool, real_store).await;
    index
        .upsert(real_store, product, image, MODEL, axis(0))
        .await
        .unwrap();
    assert_eq!(
        index
            .search(real_store, MODEL, &axis(0), 1)
            .await
            .unwrap()
            .len(),
        1
    );
}

/// A small store surrounded by 500 near-duplicate embeddings in another store:
/// without iterative index scans the filtered HNSW search exhausts its candidate
/// list on the other store before reaching this store's true neighbors.
#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn filtered_search_returns_small_store_neighbors_among_other_store_hotspot() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let memory = InMemoryVectorIndex::default();
    let store = new_store(&pool).await;
    let other = new_store(&pool).await;
    let needle = axis(0);

    // Other store: 500 products clustered near the query vector, all much closer
    // than anything the small store has. They must never leak into its hits.
    for n in 0..500 {
        let product = new_product(&pool, other).await;
        let mut vector = needle.clone();
        vector[1] = 1e-3 * ((n % 17 + 1) as f32);
        index
            .upsert(
                other,
                product,
                new_image(&pool, other).await,
                MODEL,
                vector.clone(),
            )
            .await
            .unwrap();
        memory
            .upsert(other, product, Uuid::new_v4(), MODEL, vector)
            .await
            .unwrap();
    }

    // Small store: 10 products whose similarities are distinct but tiny (~0.3-0.9).
    let mut expected: Vec<(Uuid, f32)> = Vec::new();
    for i in 0..10_u8 {
        let product = new_product(&pool, store).await;
        let mut vector = needle.clone();
        vector[1] = 0.25 * f32::from(i);
        let similarity = best_similarity(&needle, &vector);
        index
            .upsert(
                store,
                product,
                new_image(&pool, store).await,
                MODEL,
                vector.clone(),
            )
            .await
            .unwrap();
        memory
            .upsert(store, product, Uuid::new_v4(), MODEL, vector)
            .await
            .unwrap();
        expected.push((product, similarity));
    }

    let hits = index.search(store, MODEL, &needle, 10).await.unwrap();
    assert_eq!(
        hits.len(),
        10,
        "iterative scan must reach beyond the other store"
    );
    for (hit, (product, similarity)) in hits.iter().zip(&expected) {
        assert_eq!(hit.product_id, *product);
        assert!(
            (hit.similarity - similarity).abs() < 1e-5,
            "{} vs {}",
            hit.similarity,
            similarity
        );
    }
    // And the adapter agrees with the exhaustive in-memory reference on this data.
    let reference = memory.search(store, MODEL, &needle, 10).await.unwrap();
    for (hit, expected) in hits.iter().zip(&reference) {
        assert_eq!(hit.product_id, expected.product_id);
        assert!(
            (hit.similarity - expected.similarity).abs() < 1e-5,
            "{} vs {}",
            hit.similarity,
            expected.similarity
        );
    }
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn agrees_with_in_memory_index_on_random_data() {
    let Some(pool) = pool().await else { return };
    let _tidy = Tidy::start(pool.clone()).await;
    let index = PgVectorIndex::new(pool.clone());
    let memory = InMemoryVectorIndex::default();
    let store = new_store(&pool).await;
    let mut rng = Prng::new("recognition_vector/random");
    for _ in 0..24 {
        let product = new_product(&pool, store).await;
        for _ in 0..2 {
            let vector = random_vector(&mut rng);
            index
                .upsert(
                    store,
                    product,
                    new_image(&pool, store).await,
                    MODEL,
                    vector.clone(),
                )
                .await
                .unwrap();
            memory
                .upsert(store, product, Uuid::new_v4(), MODEL, vector)
                .await
                .unwrap();
        }
    }
    let query = random_vector(&mut rng);
    let hits = index.search(store, MODEL, &query, 12).await.unwrap();
    let reference = memory.search(store, MODEL, &query, 12).await.unwrap();
    assert_eq!(hits.len(), reference.len());
    for (hit, expected) in hits.iter().zip(&reference) {
        assert_eq!(hit.product_id, expected.product_id);
        assert!(
            (hit.similarity - expected.similarity).abs() < 1e-5,
            "{:?} vs {:?}",
            hit,
            expected
        );
    }
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn prototype_wins_when_references_are_noisy() {
    use taphoa_api::recognition::classify::{
        DEFAULT_MATCH_FLOOR, DEFAULT_MATCH_MARGIN, DEFAULT_MATCH_THRESHOLD, MatchClass, classify,
    };
    let pool = pool().await.expect("DATABASE_URL required");
    let _tidy = Tidy::start(pool.clone()).await;
    let store = new_store(&pool).await;
    let a = new_product(&pool, store).await;
    let b = new_product(&pool, store).await;
    let index = PgVectorIndex::new(pool.clone());
    let query = axis(0);
    let noise = 0.42_f32.sqrt();
    let mut mean = vec![0.; DIM];
    for angle in [
        0.,
        std::f32::consts::TAU / 3.,
        2. * std::f32::consts::TAU / 3.,
    ] {
        let mut reference = vec![0.; DIM];
        reference[..4].copy_from_slice(&[0.7, 0.3, noise * angle.cos(), noise * angle.sin()]);
        assert!(best_similarity(&query, &reference) < DEFAULT_MATCH_THRESHOLD);
        for (sum, value) in mean.iter_mut().zip(&reference) {
            *sum += value / 3.;
        }
        index
            .upsert(store, a, new_image(&pool, store).await, MODEL, reference)
            .await
            .unwrap();
    }
    let magnitude = mean.iter().map(|v| v * v).sum::<f32>().sqrt();
    mean.iter_mut().for_each(|v| *v /= magnitude);
    let proto_score = best_similarity(&query, &mean);
    assert!(proto_score > DEFAULT_MATCH_THRESHOLD);
    sqlx::query("INSERT INTO product_prototypes (store_id, product_id, model, embedding, reference_count) VALUES ($1, $2, $3, $4, 3)")
        .bind(store).bind(a).bind(MODEL).bind(pgvector::Vector::from(mean)).execute(&pool).await.unwrap();
    let hits = index.search(store, MODEL, &query, 5).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].product_id, a);
    assert!(
        (hits[0].similarity - proto_score).abs() < 1e-6,
        "prototype must beat references: {hits:?}"
    );
    assert_eq!(
        (
            DEFAULT_MATCH_THRESHOLD,
            DEFAULT_MATCH_MARGIN,
            DEFAULT_MATCH_FLOOR
        ),
        (0.80, 0.05, 0.60)
    );
    assert_eq!(
        classify(
            Some(hits[0].similarity),
            None,
            DEFAULT_MATCH_THRESHOLD,
            DEFAULT_MATCH_MARGIN,
            DEFAULT_MATCH_FLOOR
        ),
        MatchClass::Matched
    );
    let mut strong = axis(0);
    strong[0] = 0.98;
    strong[1] = (1. - 0.98_f32.powi(2)).sqrt();
    index
        .upsert(store, b, new_image(&pool, store).await, MODEL, strong)
        .await
        .unwrap();
    sqlx::query("INSERT INTO product_prototypes (store_id, product_id, model, embedding, reference_count) VALUES ($1, $2, $3, $4, 1)")
        .bind(store).bind(b).bind(MODEL).bind(pgvector::Vector::from(axis(1))).execute(&pool).await.unwrap();
    let hits = index.search(store, MODEL, &query, 2).await.unwrap();
    assert_eq!(
        hits.iter().map(|h| h.product_id).collect::<Vec<_>>(),
        vec![b, a]
    );
    assert!((hits[0].similarity - 0.98).abs() < 1e-6);
    assert!((hits[1].similarity - proto_score).abs() < 1e-6);
    assert_eq!(
        classify(
            Some(hits[0].similarity),
            Some(hits[1].similarity),
            DEFAULT_MATCH_THRESHOLD,
            DEFAULT_MATCH_MARGIN,
            DEFAULT_MATCH_FLOOR
        ),
        MatchClass::Matched
    );
}

#[tokio::test]
#[ignore = "real Postgres with pgvector required"]
async fn prototype_only_scope_archive_cutout_and_removal() {
    let pool = pool().await.expect("DATABASE_URL required");
    let _tidy = Tidy::start(pool.clone()).await;
    let store = new_store(&pool).await;
    let other = new_store(&pool).await;
    let index = PgVectorIndex::new(pool.clone());
    let prototype_only = new_product(&pool, store).await;
    let cutout_only = new_product(&pool, store).await;
    let archived = new_product(&pool, store).await;
    let foreign = new_product(&pool, other).await;
    let wrong_model = new_product(&pool, store).await;
    for (s, p, m) in [
        (store, prototype_only, MODEL),
        (store, archived, MODEL),
        (other, foreign, MODEL),
        (store, wrong_model, OTHER_MODEL),
    ] {
        sqlx::query("INSERT INTO product_prototypes (store_id, product_id, model, embedding, reference_count) VALUES ($1, $2, $3, $4, 1)")
            .bind(s).bind(p).bind(m).bind(pgvector::Vector::from(axis(0))).execute(&pool).await.unwrap();
    }
    index
        .upsert(
            store,
            archived,
            new_image(&pool, store).await,
            MODEL,
            axis(0),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE products SET archived = true WHERE id = $1")
        .bind(archived)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO product_embeddings (store_id, product_id, image_id, model, embedding, kind) VALUES ($1, $2, $3, $4, $5, 'cutout')")
        .bind(store).bind(cutout_only).bind(new_image(&pool, store).await).bind(MODEL).bind(pgvector::Vector::from(axis(1))).execute(&pool).await.unwrap();
    let hits = index.search(store, MODEL, &axis(0), 10).await.unwrap();
    assert_eq!(hits.len(), 2, "scope and archive filtering: {hits:?}");
    assert_eq!(hits[0].product_id, prototype_only);
    assert_eq!(hits[0].similarity, 1.);
    assert_eq!(hits[1].product_id, cutout_only);
    assert_eq!(hits[1].similarity, 0.);
    assert!(
        index
            .search(store, MODEL, &axis(0), 0)
            .await
            .unwrap()
            .is_empty()
    );
    index.remove_product(store, prototype_only).await.unwrap();
    assert_eq!(
        index
            .search(store, MODEL, &axis(0), 10)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn in_memory_prototypes_take_max_and_preserve_scope_and_validation() {
    let index = InMemoryVectorIndex::default();
    let store = Uuid::new_v4();
    let product = Uuid::new_v4();
    let other = Uuid::new_v4();
    index
        .upsert(
            store,
            product,
            Uuid::new_v4(),
            MODEL,
            vec![0.7, 0.3, 0.42_f32.sqrt()],
        )
        .await
        .unwrap();
    index
        .upsert_prototype(store, product, MODEL, vec![0.7, 0.3, 0.])
        .unwrap();
    index
        .upsert_prototype(store, other, OTHER_MODEL, vec![1., 0., 0.])
        .unwrap();
    index
        .upsert_prototype(other, other, MODEL, vec![1., 0., 0.])
        .unwrap();
    let hits = index.search(store, MODEL, &[1., 0., 0.], 5).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert!((hits[0].similarity - best_similarity(&[1., 0., 0.], &[0.7, 0.3, 0.])).abs() < 1e-6);
    index
        .upsert(store, product, Uuid::new_v4(), MODEL, vec![1., 0., 0.])
        .await
        .unwrap();
    assert_eq!(
        index.search(store, MODEL, &[1., 0., 0.], 5).await.unwrap()[0].similarity,
        1.
    );
    index
        .upsert_prototype(store, product, MODEL, vec![0., 1., 0.])
        .unwrap();
    assert_eq!(
        index.search(store, MODEL, &[1., 0., 0.], 5).await.unwrap()[0].similarity,
        1.
    );
    assert!(
        index
            .upsert_prototype(store, product, MODEL, vec![1.])
            .is_err()
    );
    assert!(
        index
            .upsert_prototype(store, product, MODEL, vec![0.; 3])
            .is_err()
    );
    assert!(
        index
            .upsert_prototype(store, product, MODEL, vec![f32::NAN; 3])
            .is_err()
    );
    index.remove_product(store, product).await.unwrap();
    assert!(
        index
            .search(store, MODEL, &[1., 0., 0.], 5)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        index
            .search(store, OTHER_MODEL, &[1., 0., 0.], 5)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        index
            .search(other, MODEL, &[1., 0., 0.], 5)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        index
            .search(store, MODEL, &[1., 0., 0.], 0)
            .await
            .unwrap()
            .is_empty()
    );
}
