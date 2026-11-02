use crate::crop::{EMBED_SIDE, l2_normalize, normalize_into};
use image::RgbImage;
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};

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
    /// Embeds decoded crops. Adapters with real batching override this; the default
    /// re-encodes each crop as PNG so any adapter works in the scan pipeline.
    fn embed_crops(&self, crops: &[image::RgbImage]) -> Result<Vec<Vec<f32>>, EmbedError> {
        crops
            .iter()
            .map(|crop| {
                let mut bytes = Vec::new();
                crop.write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .map_err(|e| EmbedError::InvalidImage(e.to_string()))?;
                self.embed(&bytes)
            })
            .collect()
    }
}

fn inference(error: impl std::fmt::Display) -> EmbedError {
    EmbedError::Inference(error.to_string())
}

/// DINOv2 ViT-S/14 (HF `transformers` ONNX export): `pixel_values` [B,3,S,S] in,
/// `last_hidden_state` [B, 1 + (S/14)^2, 384] out; token 0 (CLS) is the embedding.
pub struct DinoEmbedder {
    session: Mutex<Session>,
    model: String,
    batch: usize,
    side: u32,
}

impl DinoEmbedder {
    pub const DIM: usize = 384;
    /// Retrieval v2 uses 224 px to retain detail in distant and partially covered products.
    /// `EMBED_SIDE` still trades detail for latency (56..=224, multiples of 14).
    pub const DEFAULT_SIDE: u32 = 224;

    pub fn load(model: &Path, threads: usize) -> Result<Self, EmbedError> {
        let side = std::env::var("EMBED_SIDE")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|s: &u32| *s >= 56 && *s <= EMBED_SIDE && s.is_multiple_of(14))
            .unwrap_or(Self::DEFAULT_SIDE);
        Self::load_with_side(model, threads, side)
    }

    /// `side` must be a multiple of 14; smaller inputs trade accuracy for speed.
    pub fn load_with_side(model: &Path, threads: usize, side: u32) -> Result<Self, EmbedError> {
        let environment = crate::ort_environment().map_err(inference)?;
        let threads = if threads > 0 {
            threads
        } else {
            std::thread::available_parallelism().map_or(2, |n| n.get())
        };
        let session = Session::builder(&environment)
            .map_err(inference)?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(inference)?
            .with_intra_threads(threads)
            .map_err(inference)?
            .with_intra_op_spinning(crate::ort_spinning())
            .map_err(inference)?
            .with_inter_op_spinning(crate::ort_spinning())
            .map_err(inference)?
            .commit_from_file(model)
            .map_err(inference)?;
        let this = Self {
            session: Mutex::new(session),
            // Vectors from different input sides are not comparable, so the side is part of
            // the model id that product_embeddings are filtered by.
            model: format!("dinov2-vits14-onnx@2/lb{side}"),
            batch: 8,
            side,
        };
        // Warm-up: first run allocates arenas and packs weights.
        let vectors = this.embed_crops(&[RgbImage::new(side, side)])?;
        if vectors.first().map(Vec::len) != Some(Self::DIM) {
            return Err(inference("model must output 384-d embeddings"));
        }
        Ok(this)
    }
}

impl Embedder for DinoEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn dim(&self) -> usize {
        Self::DIM
    }

    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        let decoded = crate::crop::decode_limited(image)
            .map_err(EmbedError::InvalidImage)?
            .to_rgb8();
        self.embed_crops(&[decoded])?
            .pop()
            .ok_or_else(|| inference("no embedding returned"))
    }

    fn embed_crops(&self, crops: &[RgbImage]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let side = self.side as usize;
        let dim = Self::DIM;
        let mut out = Vec::with_capacity(crops.len());
        let mut session = self
            .session
            .lock()
            .map_err(|_| inference("embedder lock poisoned"))?;
        for chunk in crops.chunks(self.batch) {
            let mut input = vec![0.0_f32; chunk.len() * 3 * side * side];
            for (crop, slot) in chunk.iter().zip(input.chunks_mut(3 * side * side)) {
                normalize_into(crop, slot, self.side);
            }
            let outputs = session
                .run(ort::inputs![
                    "pixel_values" => Tensor::from_array(([chunk.len(), 3, side, side], input)).map_err(inference)?
                ])
                .map_err(inference)?;
            // A [B, dim] output (pooler_output) is accepted as-is.
            let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(inference)?;
            let tokens = match shape.len() {
                2 if shape[1] == dim as i64 => 1,
                3 if shape[2] == dim as i64 && shape[1] >= 1 => shape[1] as usize,
                _ => return Err(inference(format!("unexpected embedding shape {shape:?}"))),
            };
            if shape[0] != chunk.len() as i64 {
                return Err(inference(format!("unexpected embedding shape {shape:?}")));
            }
            for sample in data.chunks_exact(tokens * dim) {
                let mut v = sample[..dim].to_vec();
                l2_normalize(&mut v);
                out.push(v);
            }
        }
        Ok(out)
    }
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
    fn production_model_specs_have_distinct_preprocessing_output_and_identity() {
        let siglip = ModelSpec::siglip2();
        assert_eq!(siglip.side, 224);
        assert_eq!(siglip.mean, [0.5; 3]);
        assert_eq!(siglip.std, [0.5; 3]);
        assert_eq!(siglip.dim, 768);
        assert_eq!(siglip.output, "output");
        assert_eq!(siglip.pooling, Pooling::Pooled);
        assert_eq!(siglip.model_id(), "siglip2-b16-224-onnx@1/lb224");
        let dino = ModelSpec::dinov2(112).unwrap();
        assert_eq!(dino.dim, 384);
        assert_eq!(dino.pooling, Pooling::Cls);
        assert_eq!(dino.model_id(), "dinov2-vits14-onnx@2/lb112");
        assert!(ModelSpec::dinov2(113).is_err());
        assert!(ModelSpec::dinov2(0).is_err());
    }

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
