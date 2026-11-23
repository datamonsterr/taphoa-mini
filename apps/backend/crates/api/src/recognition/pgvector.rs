//! Postgres adapter of [`VectorIndex`] over the pgvector `product_embeddings`
//! table (architecture §5.3, data-model §3.3). Search returns the best cosine
//! similarity per product. The vectors are 384-d DINOv2 embeddings, so anything
//! else is rejected before it reaches the database.
use crate::vector::{VectorHit, VectorIndex};
use async_trait::async_trait;
use pgvector::Vector;
use sqlx::PgPool;
use uuid::Uuid;

const EMBEDDING_DIM: usize = 384;
/// Over-fetch rows from the nearest-neighbor scan so per-product grouping stays
/// meaningful when a product has several reference embeddings (docs §3.3).
const OVERFETCH: usize = 8;
const OVERFETCH_FLOOR: usize = 32;

/// Shared by checkout and catalog duplicate detection. The distance-ordered,
/// bounded reference CTE retains the HNSW access path; prototypes are few per
/// store and scored directly. No kind filter: crop and cutout both contribute.
/// Parameters: query vector, store, model, reference overfetch, product limit.
pub const SEARCH_SQL: &str = "WITH nearest AS MATERIALIZED (
    SELECT e.product_id, e.embedding <=> $1::vector AS distance
    FROM product_embeddings e
    WHERE e.store_id = $2 AND e.model = $3
      AND EXISTS (SELECT 1 FROM products p
                  WHERE p.id = e.product_id AND p.store_id = $2 AND NOT p.archived)
    ORDER BY e.embedding <=> $1::vector
    LIMIT $4
), scores AS (
    SELECT product_id, 1 - distance AS similarity FROM nearest
    UNION ALL
    SELECT proto.product_id, 1 - (proto.embedding <=> $1::vector) AS similarity
    FROM product_prototypes proto
    JOIN products p ON p.id = proto.product_id
    WHERE proto.store_id = $2 AND proto.model = $3
      AND p.store_id = $2 AND NOT p.archived
)
SELECT product_id, max(similarity)::real AS similarity
FROM scores
GROUP BY product_id
ORDER BY similarity DESC, product_id
LIMIT $5";

// One statement, one exchange: the scoring lives in `scan_search_products` (migration
// 1901, same SQL as `SEARCH_SQL`), whose function-level SET supplies the HNSW iterative
// scan settings that a transaction with SET LOCAL would otherwise need. The correlated
// LATERAL keeps the bounded HNSW access path; all detections share one pool connection.
const BATCH_SEARCH_SQL: &str = "SELECT q.ordinality, hit.product_id, hit.similarity
     FROM unnest($1::vector[]) WITH ORDINALITY AS q(embedding, ordinality)
     CROSS JOIN LATERAL scan_search_products(q.embedding, $2, $3, $4, $5) AS hit
     ORDER BY q.ordinality, hit.similarity DESC, hit.product_id";

pub struct PgVectorIndex {
    pool: PgPool,
}
impl PgVectorIndex {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Same validity rules as `InMemoryVectorIndex`, plus the fixed column dimension.
fn validate(embedding: &[f32]) -> anyhow::Result<()> {
    anyhow::ensure!(
        !embedding.is_empty() && embedding.iter().all(|x| x.is_finite()),
        "embedding must be finite and nonempty"
    );
    let norm = embedding
        .iter()
        .map(|&x| f64::from(x).powi(2))
        .sum::<f64>()
        .sqrt();
    anyhow::ensure!(norm > 0., "embedding must have nonzero norm");
    anyhow::ensure!(
        embedding.len() == EMBEDDING_DIM,
        "embedding dimension mismatch: expected {EMBEDDING_DIM}, got {}",
        embedding.len()
    );
    Ok(())
}

#[async_trait]
impl VectorIndex for PgVectorIndex {
    async fn upsert(
        &self,
        store_id: Uuid,
        product_id: Uuid,
        image_id: Uuid,
        model: &str,
        embedding: Vec<f32>,
    ) -> anyhow::Result<()> {
        validate(&embedding)?;
        sqlx::query(
            "INSERT INTO product_embeddings (store_id, product_id, image_id, model, embedding)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (store_id, product_id, image_id, model, kind)
             DO UPDATE SET embedding = EXCLUDED.embedding",
        )
        .bind(store_id)
        .bind(product_id)
        .bind(image_id)
        .bind(model)
        .bind(Vector::from(embedding))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn search(
        &self,
        store_id: Uuid,
        model: &str,
        embedding: &[f32],
        limit: usize,
    ) -> anyhow::Result<Vec<VectorHit>> {
        Ok(self
            .search_batch(store_id, model, &[embedding], limit)
            .await?
            .pop()
            .unwrap_or_default())
    }

    async fn search_batch(
        &self,
        store_id: Uuid,
        model: &str,
        embeddings: &[&[f32]],
        limit: usize,
    ) -> anyhow::Result<Vec<Vec<VectorHit>>> {
        let mut vectors = Vec::with_capacity(embeddings.len());
        for embedding in embeddings {
            validate(embedding)?;
            vectors.push(Vector::from(embedding.to_vec()));
        }
        let mut hits = vec![Vec::new(); embeddings.len()];
        if embeddings.is_empty() {
            return Ok(hits);
        }
        let fetch =
            i64::try_from(limit.saturating_mul(OVERFETCH).max(OVERFETCH_FLOOR)).unwrap_or(i64::MAX);
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows: Vec<(i64, Uuid, f32)> = sqlx::query_as(BATCH_SEARCH_SQL)
            .bind(vectors)
            .bind(store_id)
            .bind(model)
            .bind(fetch)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        for (ordinality, product_id, similarity) in rows {
            hits[(ordinality - 1) as usize].push(VectorHit {
                product_id,
                similarity,
            });
        }
        Ok(hits)
    }

    async fn remove_product(&self, store_id: Uuid, product_id: Uuid) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM product_embeddings WHERE store_id = $1 AND product_id = $2")
            .bind(store_id)
            .bind(product_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM product_prototypes WHERE store_id = $1 AND product_id = $2")
            .bind(store_id)
            .bind(product_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
