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
             ON CONFLICT (store_id, product_id, image_id, model)
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
        validate(embedding)?;
        let fetch =
            i64::try_from(limit.saturating_mul(OVERFETCH).max(OVERFETCH_FLOOR)).unwrap_or(i64::MAX);
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let mut tx = self.pool.begin().await?;
        // The HNSW index has no store partition, so filtered searches need
        // iterative index scans to keep walking it until the store's rows are
        // found; without them the candidate list is exhausted on other stores
        // first. These scopes end with the transaction.
        sqlx::query("SET LOCAL hnsw.iterative_scan = relaxed_order")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL hnsw.ef_search = 100")
            .execute(&mut *tx)
            .await?;
        // 20000 is the pgvector default (docs: approximate, larger needs more memory).
        sqlx::query("SET LOCAL hnsw.max_scan_tuples = 20000")
            .execute(&mut *tx)
            .await?;
        let rows: Vec<(Uuid, f32)> = sqlx::query_as(
            "SELECT product_id, max(1 - distance)::real AS similarity
             FROM (
                 SELECT product_id, embedding <=> $3 AS distance
                 FROM product_embeddings
                 WHERE store_id = $1 AND model = $2
                 ORDER BY distance
                 LIMIT $4
             ) nearest
             GROUP BY product_id
             ORDER BY similarity DESC, product_id
             LIMIT $5",
        )
        .bind(store_id)
        .bind(model)
        .bind(Vector::from(embedding.to_vec()))
        .bind(fetch)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(rows
            .into_iter()
            .map(|(product_id, similarity)| VectorHit {
                product_id,
                similarity,
            })
            .collect())
    }

    async fn remove_product(&self, store_id: Uuid, product_id: Uuid) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM product_embeddings WHERE store_id = $1 AND product_id = $2")
            .bind(store_id)
            .bind(product_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
