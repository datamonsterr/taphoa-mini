use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("invalid image: {0}")]
    InvalidImage(String),
    #[error("embedding failed: {0}")]
    Inference(String),
}
/// Adapters return finite, L2-normalized vectors of exactly `dim()` elements.
pub trait Embedder: Send + Sync {
    fn model(&self) -> &str;
    fn dim(&self) -> usize;
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError>;
}
/// Deterministic hash adapter for tests; never selected by production config.
#[derive(Default)]
pub struct MockEmbedder;
impl Embedder for MockEmbedder {
    fn model(&self) -> &str {
        "mock-sha256-384"
    }
    fn dim(&self) -> usize {
        384
    }
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        let mut vector = Vec::with_capacity(self.dim());
        for block in 0_u32..12 {
            let mut hasher = Sha256::new();
            hasher.update(image);
            hasher.update(block.to_be_bytes());
            vector.extend(
                hasher
                    .finalize()
                    .iter()
                    .map(|&byte| (f32::from(byte) - 127.5) / 127.5),
            );
        }
        let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
        for value in &mut vector {
            *value /= norm;
        }
        Ok(vector)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_different_and_normalized() {
        let mock = MockEmbedder;
        assert_eq!(mock.model(), "mock-sha256-384");
        let a = mock.embed(b"image a").unwrap();
        assert_eq!(a, mock.embed(b"image a").unwrap());
        assert_ne!(a, mock.embed(b"image b").unwrap());
        for vector in [a, mock.embed(b"").unwrap()] {
            assert_eq!(vector.len(), 384);
            assert_eq!(vector.len(), mock.dim());
            assert!(vector.iter().all(|x| x.is_finite()));
            assert!((vector.iter().map(|x| x * x).sum::<f32>() - 1.).abs() < 1e-5);
        }
    }
}
