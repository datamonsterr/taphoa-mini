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
    #[error(transparent)]
    Cancelled(#[from] crate::work::Cancelled),
    #[error(transparent)]
    Remote(#[from] crate::wire::RemoteError),
    #[error("invalid image: {0}")]
    InvalidImage(String),
    #[error("embedding failed: {0}")]
    Inference(String),
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
    pub letterbox: bool,
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
            letterbox: true,
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
            letterbox: false,
            identity: "dinov2-vits14-onnx@1",
        })
    }

    pub fn model_id(&self) -> String {
        if self.letterbox {
            format!("{}/lb{}", self.identity, self.side)
        } else {
            format!("{}/{}", self.identity, self.side)
        }
    }
}

/// Adapters return finite, L2-normalized vectors of exactly `dim()` elements.
pub trait Embedder: Send + Sync {
    fn model(&self) -> &str;
    fn dim(&self) -> usize;
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError>;
    fn embed_with_control(
        &self,
        image: &[u8],
        control: &crate::work::WorkControl,
    ) -> Result<Vec<f32>, EmbedError> {
        control.check()?;
        self.embed(image)
    }
    fn embed_crops_with_control(
        &self,
        crops: &[RgbImage],
        control: &crate::work::WorkControl,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        crops
            .iter()
            .map(|crop| {
                control.check()?;
                self.embed_crops(std::slice::from_ref(crop))?
                    .pop()
                    .ok_or_else(|| inference("missing crop embedding"))
            })
            .collect()
    }
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
    pub const DEFAULT_SIDE: u32 = 112;

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
        let provider = crate::provider::Provider::from_env().map_err(inference)?;
        let threads = provider.threads(threads);
        let session = provider
            .configure(Session::builder(&environment).map_err(inference)?)
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
        Ok(Self {
            session: Mutex::new(session),
            model: spec.model_id(),
            batch: 8,
            spec,
        })
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
        self.embed_crops_controlled(crops, None)
    }

    fn embed_crops_with_control(
        &self,
        crops: &[RgbImage],
        control: &crate::work::WorkControl,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.embed_crops_controlled(crops, Some(control))
    }

    fn embed_with_control(
        &self,
        bytes: &[u8],
        control: &crate::work::WorkControl,
    ) -> Result<Vec<f32>, EmbedError> {
        control.check()?;
        let image = crate::crop::decode_limited(bytes)
            .map_err(EmbedError::InvalidImage)?
            .to_rgb8();
        self.embed_crops_controlled(&[image], Some(control))?
            .pop()
            .ok_or_else(|| inference("missing embedding"))
    }
}

impl OnnxEmbedder {
    fn embed_crops_controlled(
        &self,
        crops: &[RgbImage],
        control: Option<&crate::work::WorkControl>,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        let spec = self.spec;
        let side = spec.side as usize;
        let dim = spec.dim;
        let mut out = Vec::with_capacity(crops.len());
        let mut session = self
            .session
            .lock()
            .map_err(|_| inference("embedder lock poisoned"))?;
        for chunk in crops.chunks(self.batch) {
            crate::work::checkpoint(control)?;
            let mut input = vec![0.0_f32; chunk.len() * 3 * side * side];
            for (crop, slot) in chunk.iter().zip(input.chunks_mut(3 * side * side)) {
                if crop.width() == 0 || crop.height() == 0 {
                    return Err(EmbedError::InvalidImage("empty crop".into()));
                }
                if spec.letterbox {
                    normalize_with_stats(crop, slot, spec.side, spec.mean, spec.std);
                } else {
                    crate::crop::normalize_into(crop, slot, spec.side);
                }
            }
            let outputs = session
                .run(ort::inputs![
                    "pixel_values" => Tensor::from_array(([chunk.len(), 3, side, side], input)).map_err(inference)?
                ])
                .map_err(inference)?;
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

/// Deterministic 768-d hash adapter for tests; never selected by production config.
#[derive(Default)]
pub struct MockEmbedder768;
impl Embedder for MockEmbedder768 {
    fn model(&self) -> &str {
        "mock-sha256-768"
    }
    fn dim(&self) -> usize {
        768
    }
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        let mut vector = Vec::with_capacity(self.dim());
        for block in 0_u32..24 {
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
        assert_eq!(dino.model_id(), "dinov2-vits14-onnx@1/112");
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

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[test]
    fn cancelled_crop_sequence_stops_before_next_crop() {
        struct Fake {
            control: crate::work::WorkControl,
            calls: std::sync::atomic::AtomicUsize,
        }
        impl Embedder for Fake {
            fn model(&self) -> &str {
                "fake"
            }
            fn dim(&self) -> usize {
                1
            }
            fn embed(&self, _: &[u8]) -> Result<Vec<f32>, EmbedError> {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.control.cancel();
                Ok(vec![1.])
            }
        }
        let control = crate::work::WorkControl::new(
            std::time::Instant::now() + std::time::Duration::from_secs(10),
        );
        let model = Fake {
            control: control.clone(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        let crops = vec![RgbImage::new(2, 2); 3];
        assert!(matches!(
            model.embed_crops_with_control(&crops, &control),
            Err(EmbedError::Cancelled(_))
        ));
        assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
