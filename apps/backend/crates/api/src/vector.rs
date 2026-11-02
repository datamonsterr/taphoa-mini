use async_trait::async_trait;
use std::{collections::HashMap, sync::RwLock};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VectorHit {
    pub product_id: Uuid,
    pub similarity: f32,
}
/// A 20-vote neighborhood balances reference coverage and search cost before accuracy retuning.
pub const DEFAULT_EMBED_KNN: usize = 20;
/// Three supporting views are required for an unpenalized product score.
pub const VOTES_PER_PRODUCT: usize = 3;
/// Augmented references can dominate neighbors; overfetch before capping votes per product.
const KNN_OVERFETCH: usize = 8;
/// Minimum scan size for small requested neighborhoods.
const KNN_OVERFETCH_FLOOR: usize = 32;
/// Eight photos, crop and cutout, and seven views can produce 112 vectors per product.
/// Reserve that capacity per requested result so a heavily augmented product cannot
/// exhaust the scan before enough distinct products are seen.
const MAX_PRODUCT_REFERENCE_VECTORS: usize = 8 * 2 * 7;

pub fn embed_knn() -> usize {
    std::env::var("EMBED_KNN")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or(DEFAULT_EMBED_KNN)
}

/// Return (reference scan size, voting budget). Reserve enough votes for the requested top-k.
pub fn search_limits(limit: usize, knn: usize) -> (usize, usize) {
    let votes = knn.max(limit.saturating_mul(VOTES_PER_PRODUCT));
    (
        votes
            .saturating_mul(KNN_OVERFETCH)
            .max(limit.saturating_mul(MAX_PRODUCT_REFERENCE_VECTORS))
            .max(KNN_OVERFETCH_FLOOR),
        votes,
    )
}

/// Score reference hits using the same capped voting rule as production search.
pub fn voting_scores(
    mut references: Vec<VectorHit>,
    prototypes: Vec<VectorHit>,
    limit: usize,
) -> Vec<VectorHit> {
    let (fetch, budget) = search_limits(limit, embed_knn());
    let order = |a: &VectorHit, b: &VectorHit| {
        b.similarity
            .total_cmp(&a.similarity)
            .then_with(|| a.product_id.cmp(&b.product_id))
    };
    references.sort_by(order);
    references.truncate(fetch);
    let mut counts = HashMap::<Uuid, usize>::new();
    let mut scores = HashMap::<Uuid, f32>::new();
    let mut votes = 0;
    for hit in references {
        let count = counts.entry(hit.product_id).or_default();
        if *count == VOTES_PER_PRODUCT {
            continue;
        }
        if votes == budget {
            break;
        }
        *count += 1;
        votes += 1;
        *scores.entry(hit.product_id).or_default() += hit.similarity / VOTES_PER_PRODUCT as f32;
    }
    for hit in prototypes {
        scores.entry(hit.product_id).or_insert(hit.similarity);
    }
    let mut hits: Vec<_> = scores
        .into_iter()
        .map(|(product_id, similarity)| VectorHit {
            product_id,
            similarity,
        })
        .collect();
    hits.sort_by(order);
    hits.truncate(limit);
    hits
}

#[async_trait]
pub trait VectorIndex: Send + Sync {
    async fn upsert(
        &self,
        store_id: Uuid,
        product_id: Uuid,
        image_id: Uuid,
        model: &str,
        embedding: Vec<f32>,
    ) -> anyhow::Result<()>;
    async fn search(
        &self,
        store_id: Uuid,
        model: &str,
        embedding: &[f32],
        limit: usize,
    ) -> anyhow::Result<Vec<VectorHit>>;
    async fn remove_product(&self, store_id: Uuid, product_id: Uuid) -> anyhow::Result<()>;
}
// None is an explicitly supplied prototype; Some(image) is a reference.
type ReferenceKey = (Uuid, Uuid, Option<Uuid>, String);
#[derive(Default)]
pub struct InMemoryVectorIndex {
    entries: RwLock<HashMap<ReferenceKey, Vec<f32>>>,
}
impl InMemoryVectorIndex {
    /// Supply a worker-computed prototype without changing the VectorIndex trait.
    pub fn upsert_prototype(
        &self,
        store_id: Uuid,
        product_id: Uuid,
        model: &str,
        embedding: Vec<f32>,
    ) -> anyhow::Result<()> {
        self.store_embedding(store_id, product_id, None, model, embedding)
    }

    fn store_embedding(
        &self,
        store_id: Uuid,
        product_id: Uuid,
        image_id: Option<Uuid>,
        model: &str,
        embedding: Vec<f32>,
    ) -> anyhow::Result<()> {
        norm(&embedding)?;
        let mut entries = self
            .entries
            .write()
            .map_err(|_| anyhow::anyhow!("vector index lock poisoned"))?;
        anyhow::ensure!(
            entries
                .iter()
                .all(|((_, _, _, m), v)| m != model || v.len() == embedding.len()),
            "model embedding dimension mismatch"
        );
        entries.insert((store_id, product_id, image_id, model.into()), embedding);
        Ok(())
    }
}
fn norm(embedding: &[f32]) -> anyhow::Result<f64> {
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
    Ok(norm)
}
#[async_trait]
impl VectorIndex for InMemoryVectorIndex {
    async fn upsert(
        &self,
        store_id: Uuid,
        product_id: Uuid,
        image_id: Uuid,
        model: &str,
        embedding: Vec<f32>,
    ) -> anyhow::Result<()> {
        self.store_embedding(store_id, product_id, Some(image_id), model, embedding)
    }

    async fn search(
        &self,
        store_id: Uuid,
        model: &str,
        embedding: &[f32],
        limit: usize,
    ) -> anyhow::Result<Vec<VectorHit>> {
        let query_norm = norm(embedding)?;
        let entries = self
            .entries
            .read()
            .map_err(|_| anyhow::anyhow!("vector index lock poisoned"))?;
        let mut references = Vec::new();
        let mut prototypes = Vec::new();
        for ((store, product, image, m), vector) in entries.iter() {
            if *store != store_id || m != model {
                continue;
            }
            anyhow::ensure!(
                vector.len() == embedding.len(),
                "model embedding dimension mismatch"
            );
            let dot = embedding
                .iter()
                .zip(vector)
                .map(|(&a, &b)| f64::from(a) * f64::from(b))
                .sum::<f64>();
            let similarity = (dot / (query_norm * norm(vector)?)).clamp(-1., 1.) as f32;
            let hit = VectorHit {
                product_id: *product,
                similarity,
            };
            if image.is_some() {
                references.push(hit);
            } else {
                prototypes.push(hit);
            }
        }
        Ok(voting_scores(references, prototypes, limit))
    }
    async fn remove_product(&self, store_id: Uuid, product_id: Uuid) -> anyhow::Result<()> {
        self.entries
            .write()
            .map_err(|_| anyhow::anyhow!("vector index lock poisoned"))?
            .retain(|(store, product, _, _), _| *store != store_id || *product != product_id);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overfetch_reserves_capacity_for_distinct_augmented_products() {
        let (fetch, votes) = search_limits(5, DEFAULT_EMBED_KNN);
        assert!(fetch >= 5 * 112);
        assert_eq!(votes, 20);
        assert_eq!(search_limits(10, 7).1, 30);
    }

    #[tokio::test]
    async fn voting_rewards_three_hits_and_uses_product_margin_and_prototype_fallback() {
        use crate::recognition::classify::{MatchClass, classify};
        let index = InMemoryVectorIndex::default();
        let (store, supported, singleton, fallback) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        for score in [0.91_f32, 0.90, 0.89, 0.10] {
            index
                .upsert(
                    store,
                    supported,
                    Uuid::new_v4(),
                    "m",
                    vec![score, (1. - score * score).sqrt()],
                )
                .await
                .unwrap();
        }
        index
            .upsert(store, singleton, Uuid::new_v4(), "m", vec![1., 0.])
            .await
            .unwrap();
        index
            .upsert_prototype(store, supported, "m", vec![1., 0.])
            .unwrap();
        index
            .upsert_prototype(store, singleton, "m", vec![1., 0.])
            .unwrap();
        index
            .upsert_prototype(
                store,
                fallback,
                "m",
                vec![0.82, (1. - 0.82_f32.powi(2)).sqrt()],
            )
            .unwrap();
        let hits = index.search(store, "m", &[1., 0.], 3).await.unwrap();
        assert_eq!(
            hits.iter().map(|h| h.product_id).collect::<Vec<_>>(),
            vec![supported, fallback, singleton]
        );
        for (hit, expected) in hits.iter().zip([0.90, 0.82, 1. / 3.]) {
            assert!((hit.similarity - expected).abs() < 1e-6);
        }
        assert!((hits[0].similarity - hits[1].similarity - 0.08).abs() < 1e-6);
        assert_eq!(
            classify(
                Some(hits[0].similarity),
                Some(hits[1].similarity),
                0.80,
                0.05,
                0.60
            ),
            MatchClass::Matched
        );
    }

    #[tokio::test]
    async fn cosine_voting_scope_upsert_remove_and_limit() {
        let index = InMemoryVectorIndex::default();
        let (store, other, p1, p2) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let image = Uuid::new_v4();
        for (s, p, i, m, v) in [
            (store, p1, image, "m", vec![0., 2.]),
            (store, p1, Uuid::new_v4(), "m", vec![4., 0.]),
            (store, p2, Uuid::new_v4(), "m", vec![1., 1.]),
            (other, p2, Uuid::new_v4(), "m", vec![1., 0.]),
            (store, p2, Uuid::new_v4(), "other", vec![1., 0.]),
        ] {
            index.upsert(s, p, i, m, v).await.unwrap();
        }
        let hits = index.search(store, "m", &[2., 0.], 10).await.unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0],
            VectorHit {
                product_id: p1,
                similarity: 1. / 3.
            }
        );
        assert!((hits[1].similarity - 0.70710677 / 3.).abs() < 1e-6);
        assert_eq!(
            index.search(store, "m", &[2., 0.], 1).await.unwrap().len(),
            1
        );
        index
            .upsert(store, p1, image, "m", vec![-1., 0.])
            .await
            .unwrap();
        index.remove_product(store, p1).await.unwrap();
        assert_eq!(
            index.search(store, "m", &[1., 0.], 10).await.unwrap().len(),
            1
        );
        index.remove_product(store, p2).await.unwrap();
        assert_eq!(
            index.search(other, "m", &[1., 0.], 10).await.unwrap().len(),
            1
        );
        assert_eq!(
            index
                .search(store, "other", &[1., 0.], 10)
                .await
                .unwrap()
                .len(),
            0
        );
    }
    #[tokio::test]
    async fn rejects_invalid_embeddings_and_dimension_mismatch() {
        let index = InMemoryVectorIndex::default();
        let id = Uuid::nil();
        for vector in [
            vec![],
            vec![0., 0.],
            vec![f32::NAN, 1.],
            vec![f32::INFINITY],
        ] {
            assert!(index.upsert(id, id, id, "m", vector).await.is_err());
        }
        index.upsert(id, id, id, "m", vec![1., 0.]).await.unwrap();
        assert!(index.upsert(id, id, id, "m", vec![1.]).await.is_err());
        assert!(index.search(id, "m", &[1.], 1).await.is_err());
    }
}
