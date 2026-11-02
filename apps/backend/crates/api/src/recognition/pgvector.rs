//! Postgres adapter of [`VectorIndex`] over the pgvector `product_embeddings`
//! table (architecture §5.3, data-model §3.3). Search returns a cosine
//! top-three reference voting score per product. The vectors are 384-d DINOv2 embeddings, so anything
//! else is rejected before it reaches the database.
use crate::vector::{VectorHit, VectorIndex, embed_knn, search_limits};
use async_trait::async_trait;
use pgvector::Vector;
use sqlx::PgPool;
use uuid::Uuid;

const EMBEDDING_DIM: usize = 384;
/// Shared by checkout and duplicate detection. A distance-ordered bounded CTE keeps
/// the HNSW access path. Cap each product at three votes before the neighborhood limit
/// so augmented references cannot monopolize it. Missing votes contribute zero.
/// Parameters: query, store, model, reference overfetch, product limit, voting budget.
pub const SEARCH_SQL: &str = "WITH nearest AS MATERIALIZED (
    SELECT e.product_id, e.embedding <=> $1::vector AS distance
    FROM product_embeddings e
    WHERE e.store_id = $2 AND e.model = $3
      AND EXISTS (SELECT 1 FROM products p
                  WHERE p.id = e.product_id AND p.store_id = $2 AND NOT p.archived)
    ORDER BY e.embedding <=> $1::vector
    LIMIT $4
), ranked AS (
    SELECT product_id, distance,
           row_number() OVER (PARTITION BY product_id ORDER BY distance) AS rank
    FROM nearest
), votes AS MATERIALIZED (
    SELECT product_id, distance FROM ranked WHERE rank <= 3
    ORDER BY distance, product_id LIMIT $6
), scores AS (
    SELECT product_id, sum(1 - distance) / 3 AS similarity
    FROM votes GROUP BY product_id
    UNION ALL
    SELECT proto.product_id, 1 - (proto.embedding <=> $1::vector) AS similarity
    FROM product_prototypes proto
    JOIN products p ON p.id = proto.product_id
    WHERE proto.store_id = $2 AND proto.model = $3
      AND p.store_id = $2 AND NOT p.archived
      AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.product_id = proto.product_id)
)
SELECT product_id, similarity::real AS similarity
FROM scores
ORDER BY similarity DESC, product_id
LIMIT $5";

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
             ON CONFLICT (store_id, product_id, image_id, model, kind, augmentation)
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
        let (fetch, votes) = search_limits(limit, embed_knn());
        let fetch = i64::try_from(fetch).unwrap_or(i64::MAX);
        let votes = i64::try_from(votes).unwrap_or(i64::MAX);
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
        let rows: Vec<(Uuid, f32)> = sqlx::query_as(SEARCH_SQL)
            .bind(Vector::from(embedding.to_vec()))
            .bind(store_id)
            .bind(model)
            .bind(fetch)
            .bind(limit)
            .bind(votes)
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
