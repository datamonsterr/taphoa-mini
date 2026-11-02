use crate::crop::{EMBED_SIDE, IMAGENET_MEAN, IMAGENET_STD, l2_normalize, normalize_with_stats};
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

/// Output contract of a pinned ONNX export. Pooling is explicit: SigLIP2's learned
/// pooler is not interchangeable with its first patch token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pooling {
    Cls,
    Pooled,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub side: u32,
    pub mean: [f32; 3],
    pub std: [f32; 3],
    pub output: &'static str,
    pub pooling: Pooling,
    pub dim: usize,
    identity: &'static str,
}
impl ModelSpec {
    pub const fn siglip2() -> Self {
        Self {
            side: 224,
            mean: [0.5; 3],
            std: [0.5; 3],
            output: "output",
            pooling: Pooling::Pooled,
            dim: 768,
            identity: "siglip2-b16-224-onnx@1",
        }
    }
    pub fn dinov2(side: u32) -> Result<Self, EmbedError> {
        if !(56..=EMBED_SIDE).contains(&side) || !side.is_multiple_of(14) {
            return Err(inference(
                "DINOv2 side must be a multiple of 14 within 56..=224",
            ));
        }
        Ok(Self {
            side,
            mean: IMAGENET_MEAN,
            std: IMAGENET_STD,
            output: "last_hidden_state",
            pooling: Pooling::Cls,
            dim: 384,
            identity: "dinov2-vits14-onnx@2",
        })
    }
    pub fn model_id(&self) -> String {
        format!("{}/lb{}", self.identity, self.side)
    }
}

/// Both production encoders share preprocessing, batching, inference and normalization.
pub struct OnnxEmbedder {
    session: Mutex<Session>,
    model: String,
    batch: usize,
    spec: ModelSpec,
}
/// Compatibility name for callers explicitly requesting the DINOv2 model.
pub type DinoEmbedder = OnnxEmbedder;

impl OnnxEmbedder {
    pub const DIM: usize = 384;
    pub const DEFAULT_SIDE: u32 = 224;

    /// Legacy DINOv2 constructor. Production selection uses `load_with_spec`.
    pub fn load(model: &Path, threads: usize) -> Result<Self, EmbedError> {
        let side = std::env::var("EMBED_SIDE")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|s: &u32| *s >= 56 && *s <= EMBED_SIDE && s.is_multiple_of(14))
            .unwrap_or(Self::DEFAULT_SIDE);
        Self::load_with_side(model, threads, side)
    }
    pub fn load_with_side(model: &Path, threads: usize, side: u32) -> Result<Self, EmbedError> {
        Self::load_with_spec(model, threads, ModelSpec::dinov2(side)?)
    }
    pub fn load_with_spec(
        model: &Path,
        threads: usize,
        spec: ModelSpec,
    ) -> Result<Self, EmbedError> {
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
            model: spec.model_id(),
            batch: 8,
            spec,
        };
        // Warm-up allocates arenas, packs weights and checks the export's output contract.
        this.embed_crops(&[RgbImage::new(spec.side, spec.side)])?;
        Ok(this)
    }
}
impl Embedder for OnnxEmbedder {
    fn model(&self) -> &str {
        &self.model
    }
    fn dim(&self) -> usize {
        self.spec.dim
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
        let spec = self.spec;
        let side = spec.side as usize;
        let dim = spec.dim;
        let mut out = Vec::with_capacity(crops.len());
        let mut session = self
            .session
            .lock()
            .map_err(|_| inference("embedder lock poisoned"))?;
        for chunk in crops.chunks(self.batch) {
            let mut input = vec![0.0_f32; chunk.len() * 3 * side * side];
            for (crop, slot) in chunk.iter().zip(input.chunks_mut(3 * side * side)) {
                if crop.width() == 0 || crop.height() == 0 {
                    return Err(EmbedError::InvalidImage("empty crop".into()));
                }
                normalize_with_stats(crop, slot, spec.side, spec.mean, spec.std);
            }
            let outputs = session.run(ort::inputs![
                "pixel_values" => Tensor::from_array(([chunk.len(),3,side,side],input)).map_err(inference)?
            ]).map_err(inference)?;
            let output = outputs
                .get(spec.output)
                .ok_or_else(|| inference(format!("missing output {}", spec.output)))?;
            let (shape, data) = output.try_extract_tensor::<f32>().map_err(inference)?;
            let tokens = match (spec.pooling, shape.len()) {
                (Pooling::Pooled, 2) if shape[1] == dim as i64 => 1,
                (Pooling::Cls, 3) if shape[2] == dim as i64 && shape[1] >= 1 => shape[1] as usize,
                _ => return Err(inference(format!("unexpected embedding shape {shape:?}"))),
            };
            if shape[0] != chunk.len() as i64 {
                return Err(inference(format!("unexpected embedding shape {shape:?}")));
            }
            for sample in data.chunks_exact(tokens * dim) {
                let mut v = sample[..dim].to_vec();
                if !v.iter().all(|x| x.is_finite()) || !v.iter().any(|x| *x != 0.) {
                    return Err(inference("model returned non-finite or zero embedding"));
                }
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
