use super::{
    OcrError, OcrLine, PpOcrDetector, ReceiptOcr, TextDetector, decode, group_lines, inference,
    session, union,
};
use image::{
    RgbImage,
    imageops::{FilterType, crop_imm, resize},
};
use ort::{
    session::Session,
    value::{Tensor, TensorRef},
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Deserialize)]
pub(super) struct Vocab {
    image_height: u32,
    image_min_width: u32,
    image_max_width: u32,
    max_seq_length: usize,
    sos: i64,
    eos: i64,
    offset: i64,
    vocab: String,
}
impl Vocab {
    pub(super) fn width(&self, width: u32, height: u32) -> u32 {
        // The Python reference truncates before rounding up to a multiple of ten.
        let scaled =
            (u64::from(self.image_height) * u64::from(width) / u64::from(height.max(1))) as u32;
        (scaled.div_ceil(10) * 10).clamp(self.image_min_width, self.image_max_width)
    }
    pub(super) fn character(&self, token: i64) -> Option<char> {
        usize::try_from(token.checked_sub(self.offset)?)
            .ok()
            .and_then(|i| self.vocab.chars().nth(i))
    }
    fn validate(&self) -> Result<(), OcrError> {
        let size = (self.vocab.chars().count() as i64)
            .checked_add(self.offset)
            .ok_or_else(|| inference("invalid VietOCR vocabulary offset"))?;
        if self.image_height != 32
            || self.image_min_width == 0
            || self.image_min_width > self.image_max_width
            || self.image_max_width > 4096
            || !(1..=1024).contains(&self.max_seq_length)
            || self.offset < 0
            || self.vocab.is_empty()
            || !(0..self.offset).contains(&self.sos)
            || !(0..self.offset).contains(&self.eos)
            || self.sos == self.eos
            || size > 4096
        {
            return Err(inference("invalid VietOCR vocabulary metadata"));
        }
        Ok(())
    }
}

#[derive(Default, Clone)]
pub(super) struct Decoded {
    pub text: String,
    pub confidence: f32,
    tokens: usize,
}

/// Runtime-independent greedy loop. The callback owns recurrent hidden state; all samples
/// advance together, but finished samples never append tokens or affect their confidence.
pub(super) fn greedy_decode(
    meta: &Vocab,
    batch: usize,
    mut step: impl FnMut(&[i64]) -> Result<Vec<f32>, OcrError>,
) -> Result<Vec<Decoded>, OcrError> {
    let mut tgt = vec![meta.sos; batch];
    let mut done = vec![false; batch];
    let mut out = vec![Decoded::default(); batch];
    for _ in 0..meta.max_seq_length {
        let probs = step(&tgt)?;
        if probs.is_empty()
            || batch == 0
            || !probs.len().is_multiple_of(batch)
            || probs.iter().any(|v| !v.is_finite())
        {
            return Err(inference("invalid decoder log probabilities"));
        }
        let classes = probs.len() / batch;
        for (i, row) in probs.chunks_exact(classes).enumerate() {
            let (token, log_prob) = row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .ok_or_else(|| inference("empty decoder vocabulary"))?;
            tgt[i] = token as i64;
            if done[i] {
                continue;
            }
            if tgt[i] == meta.eos {
                done[i] = true;
            } else if let Some(c) = meta.character(tgt[i]) {
                out[i].text.push(c);
                out[i].confidence += log_prob.exp().clamp(0., 1.);
                out[i].tokens += 1;
            }
        }
        if done.iter().all(|d| *d) {
            break;
        }
    }
    for decoded in &mut out {
        if decoded.tokens > 0 {
            decoded.confidence /= decoded.tokens as f32;
        }
    }
    Ok(out)
}

struct Sessions {
    encoder: Session,
    decoder: Session,
}
/// VietOCR vgg_seq2seq, one encoder and one recurrent decoder session. Equal-width crops
/// are batched, with bounded batch size to avoid unbounded arenas on dense documents.
pub struct VietOcr {
    detector: Arc<PpOcrDetector>,
    sessions: Mutex<Sessions>,
    vocab: Vocab,
}
impl VietOcr {
    pub fn load(
        detector: Arc<PpOcrDetector>,
        encoder: &Path,
        decoder: &Path,
        vocab: &Path,
        threads: usize,
    ) -> Result<Self, OcrError> {
        let vocab: Vocab =
            serde_json::from_slice(&std::fs::read(vocab).map_err(inference)?).map_err(inference)?;
        vocab.validate()?;
        Ok(Self {
            detector,
            sessions: Mutex::new(Sessions {
                encoder: session(encoder, threads)?,
                decoder: session(decoder, threads)?,
            }),
            vocab,
        })
    }
    /// Share the same detection session between checkout document signals and receipt OCR.
    pub fn detector(&self) -> Arc<dyn TextDetector> {
        self.detector.clone()
    }

    fn recognize(&self, crops: &[RgbImage]) -> Result<Vec<Decoded>, OcrError> {
        let mut by_width: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
        for (i, crop) in crops.iter().enumerate() {
            by_width
                .entry(self.vocab.width(crop.width(), crop.height()))
                .or_default()
                .push(i);
        }
        let mut out = vec![Decoded::default(); crops.len()];
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| inference("VietOCR lock poisoned"))?;
        let Sessions { encoder, decoder } = &mut *sessions;
        for (width, indices) in by_width {
            for indices in indices.chunks(16) {
                let batch = indices.len();
                let plane = 32 * width as usize;
                let mut input = vec![0.; batch * 3 * plane];
                for (&index, slot) in indices.iter().zip(input.chunks_mut(3 * plane)) {
                    let crop = resize(&crops[index], width, 32, FilterType::Lanczos3);
                    for (i, pixel) in crop.pixels().enumerate() {
                        for c in 0..3 {
                            slot[c * plane + i] = pixel[c] as f32 / 255.;
                        }
                    }
                }
                let encoded = encoder.run(ort::inputs![
                    "image" => Tensor::from_array(([batch, 3, 32, width as usize], input)).map_err(inference)?
                ]).map_err(inference)?;
                let (hidden_shape, hidden) = encoded
                    .get("hidden")
                    .ok_or_else(|| inference("missing hidden output"))?
                    .try_extract_tensor::<f32>()
                    .map_err(inference)?;
                if hidden_shape.as_ref() != [batch as i64, 256] {
                    return Err(inference(format!(
                        "unexpected encoder hidden shape {hidden_shape:?}"
                    )));
                }
                let mut hidden = hidden.to_vec();
                let (eo_shape, eo) = encoded
                    .get("encoder_outputs")
                    .ok_or_else(|| inference("missing encoder_outputs output"))?
                    .try_extract_tensor::<f32>()
                    .map_err(inference)?;
                if eo_shape.len() != 3
                    || eo_shape[0] <= 0
                    || eo_shape[1] != batch as i64
                    || eo_shape[2] != 512
                {
                    return Err(inference(format!(
                        "unexpected encoder output shape {eo_shape:?}"
                    )));
                }
                let decoded = greedy_decode(&self.vocab, batch, |tgt| {
                    let result = decoder.run(ort::inputs![
                        "tgt" => TensorRef::from_array_view(([batch], tgt)).map_err(inference)?,
                        "hidden" => TensorRef::from_array_view(([batch, 256], hidden.as_slice())).map_err(inference)?,
                        "encoder_outputs" => TensorRef::from_array_view((eo_shape.to_vec(), eo)).map_err(inference)?
                    ]).map_err(inference)?;
                    let (shape, probs) = result
                        .get("log_probs")
                        .ok_or_else(|| inference("missing log_probs output"))?
                        .try_extract_tensor::<f32>()
                        .map_err(inference)?;
                    if shape.as_ref()
                        != [
                            batch as i64,
                            self.vocab.vocab.chars().count() as i64 + self.vocab.offset,
                        ]
                    {
                        return Err(inference(format!(
                            "unexpected decoder probabilities shape {shape:?}"
                        )));
                    }
                    let (shape, new_hidden) = result
                        .get("new_hidden")
                        .ok_or_else(|| inference("missing new_hidden output"))?
                        .try_extract_tensor::<f32>()
                        .map_err(inference)?;
                    if shape.as_ref() != [batch as i64, 256] {
                        return Err(inference(format!(
                            "unexpected decoder hidden shape {shape:?}"
                        )));
                    }
                    hidden.copy_from_slice(new_hidden);
                    Ok(probs.to_vec())
                })?;
                for (&index, text) in indices.iter().zip(decoded) {
                    out[index] = text;
                }
            }
        }
        Ok(out)
    }
}
impl ReceiptOcr for VietOcr {
    fn read_lines(&self, bytes: &[u8]) -> Result<Vec<OcrLine>, OcrError> {
        let image = decode(bytes)?;
        let lines = group_lines(self.detector.detect_rgb(&image)?);
        let mut crops = Vec::new();
        for line in &lines {
            for b in line {
                // Python int truncation for each edge, matching the working prototype.
                let [x, y, w, h] = b.bbox;
                let x0 = x as u32;
                let y0 = y as u32;
                let x1 = ((x + w) as u32).min(image.width());
                let y1 = ((y + h) as u32).min(image.height());
                if x1 <= x0 || y1 <= y0 {
                    return Err(inference("empty detected text crop"));
                }
                crops.push(crop_imm(&image, x0, y0, x1 - x0, y1 - y0).to_image());
            }
        }
        let mut decoded = self.recognize(&crops)?.into_iter();
        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            let mut texts = Vec::new();
            let (mut confidence, mut tokens) = (0., 0);
            for _ in &line {
                let text = decoded
                    .next()
                    .ok_or_else(|| inference("missing decoded crop"))?;
                confidence += text.confidence * text.tokens as f32;
                tokens += text.tokens;
                let trimmed = text.text.trim();
                if !trimmed.is_empty() {
                    texts.push(trimmed.to_owned());
                }
            }
            out.push(OcrLine {
                text: texts.join(" "),
                bbox: union(&line),
                confidence: if tokens == 0 {
                    0.
                } else {
                    confidence / tokens as f32
                },
            });
        }
        Ok(out)
    }
}
