use image::{RgbImage, imageops::FilterType};
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use std::{path::Path, sync::Mutex};
use taphoa_recognition::{EmbedError, Embedder, crop};

pub struct GenericEmbedder {
    session: Mutex<Session>,
    dim: usize,
    pooling: String,
    mean: [f32; 3],
    std: [f32; 3],
}
impl GenericEmbedder {
    pub fn load(
        path: &Path,
        dim: usize,
        pooling: &str,
        mean: [f32; 3],
        std: [f32; 3],
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if dim == 0
            || !matches!(pooling, "cls" | "cls-gem" | "pooled")
            || std.iter().any(|x| !x.is_finite() || *x <= 0.0)
            || mean.iter().any(|x| !x.is_finite())
        {
            return Err("invalid dim, pooling, mean or std".into());
        }
        let env = ort::init_from(
            std::env::var("ORT_DYLIB_PATH").unwrap_or_else(|_| "libonnxruntime.so".into()),
        )?
        .build()?;
        let session = Session::builder(&env)?
            .with_optimization_level(GraphOptimizationLevel::All)?
            .with_intra_threads(4)?
            .with_intra_op_spinning(false)?
            .with_inter_op_spinning(false)?
            .commit_from_file(path)?;
        Ok(Self {
            session: Mutex::new(session),
            dim,
            pooling: pooling.into(),
            mean,
            std,
        })
    }
}
impl Embedder for GenericEmbedder {
    fn model(&self) -> &str {
        "eval-only"
    }
    fn dim(&self) -> usize {
        if self.pooling == "cls-gem" {
            self.dim * 2
        } else {
            self.dim
        }
    }
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        let img = crop::decode_limited(image)
            .map_err(EmbedError::InvalidImage)?
            .to_rgb8();
        self.embed_crops(&[img])?
            .pop()
            .ok_or_else(|| EmbedError::Inference("no vector".into()))
    }
    fn embed_crops(&self, crops: &[RgbImage]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let err = |e: String| EmbedError::Inference(e);
        let mut session = self.session.lock().map_err(|e| err(e.to_string()))?;
        let mut result = Vec::new();
        for chunk in crops.chunks(8) {
            let mut data = vec![0.0_f32; chunk.len() * 3 * 224 * 224];
            for (img, out) in chunk.iter().zip(data.chunks_mut(3 * 224 * 224)) {
                if img.width() == 0 || img.height() == 0 {
                    return Err(err("empty image".into()));
                }
                let scale = 224.0 / f64::from(img.width().max(img.height()));
                let w = (f64::from(img.width()) * scale).round().max(1.) as u32;
                let h = (f64::from(img.height()) * scale).round().max(1.) as u32;
                for c in 0..3 {
                    let background = (self.mean[c] * 255.).round().clamp(0., 255.) / 255.;
                    out[c * 224 * 224..(c + 1) * 224 * 224]
                        .fill((background - self.mean[c]) / self.std[c]);
                }
                let resized = image::imageops::resize(img, w, h, FilterType::CatmullRom);
                for (x, y, pixel) in resized.enumerate_pixels() {
                    for c in 0..3 {
                        out[c * 224 * 224
                            + (y + (224 - h) / 2) as usize * 224
                            + (x + (224 - w) / 2) as usize] =
                            (f32::from(pixel[c]) / 255. - self.mean[c]) / self.std[c];
                    }
                }
            }
            let outputs = session.run(ort::inputs!["pixel_values" => Tensor::from_array(([chunk.len(),3,224,224],data)).map_err(|e| err(e.to_string()))?]).map_err(|e| err(e.to_string()))?;
            let (shape, values) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| err(e.to_string()))?;
            let tokens = match shape.len() {
                2 if shape[1] == self.dim as i64 && self.pooling == "pooled" => 1,
                3 if shape[2] == self.dim as i64 && shape[1] >= 1 && self.pooling != "pooled" => {
                    shape[1] as usize
                }
                _ => {
                    return Err(err(format!(
                        "unexpected output shape {shape:?} for {}",
                        self.pooling
                    )));
                }
            };
            if shape[0] != chunk.len() as i64 || (self.pooling == "cls-gem" && tokens < 2) {
                return Err(err(format!("unexpected output shape {shape:?}")));
            }
            for sample in values.chunks_exact(tokens * self.dim) {
                let mut v = sample[..self.dim].to_vec();
                if self.pooling == "cls-gem" {
                    for c in 0..self.dim {
                        let avg = (1..tokens)
                            .map(|t| sample[t * self.dim + c].max(0.).powi(3))
                            .sum::<f32>()
                            / (tokens - 1) as f32;
                        v.push(avg.cbrt());
                    }
                }
                crop::l2_normalize(&mut v);
                result.push(v);
            }
        }
        Ok(result)
    }
}
