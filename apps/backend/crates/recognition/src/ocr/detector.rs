use super::{
    DocumentSignal, OcrError, TextBox, TextDetector, decode, document_signal, inference, session,
    unclip,
};
use crate::crop::{IMAGENET_MEAN, IMAGENET_STD};
use image::{
    RgbImage,
    imageops::{FilterType, resize},
};
use ort::{session::Session, value::Tensor};
use std::{path::Path, sync::Mutex};

/// PP-OCRv6 small DB detector. A single shared session serializes mutable ORT runs.
pub struct PpOcrDetector {
    session: Mutex<Session>,
}
impl PpOcrDetector {
    pub fn load(model: &Path, threads: usize) -> Result<Self, OcrError> {
        Ok(Self {
            session: Mutex::new(session(model, threads)?),
        })
    }
    pub(super) fn detect_rgb(&self, image: &RgbImage) -> Result<Vec<TextBox>, OcrError> {
        let (width, height) = image.dimensions();
        let scale = 960. / width.max(height) as f64;
        // Match the reference's multiple-of-32 resize, retaining separate inverse scales.
        let w = ((width as f64 * scale / 32.).round_ties_even() as u32 * 32).max(32);
        let h = ((height as f64 * scale / 32.).round_ties_even() as u32 * 32).max(32);
        let resized = resize(image, w, h, FilterType::CatmullRom);
        let plane = w as usize * h as usize;
        let mut input = vec![0.; 3 * plane];
        for (i, pixel) in resized.pixels().enumerate() {
            for c in 0..3 {
                input[c * plane + i] =
                    (pixel[c] as f32 / 255. - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
            }
        }
        let mut session = self
            .session
            .lock()
            .map_err(|_| inference("detector lock poisoned"))?;
        let out = session.run(ort::inputs![
            "x" => Tensor::from_array(([1, 3, h as usize, w as usize], input)).map_err(inference)?
        ]).map_err(inference)?;
        let (shape, prob) = out
            .get("fetch_name_0")
            .ok_or_else(|| inference("missing detector probability map"))?
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        if shape.as_ref() != [1, 1, h as i64, w as i64] {
            return Err(inference(format!("unexpected detector shape {shape:?}")));
        }
        Ok(db_boxes(prob, w as usize, h as usize, width, height))
    }
}
impl TextDetector for PpOcrDetector {
    fn detect(&self, image: &[u8]) -> Result<Vec<TextBox>, OcrError> {
        self.detect_rgb(&decode(image)?)
    }
    fn document_signal(&self, image: &[u8]) -> Result<DocumentSignal, OcrError> {
        let image = decode(image)?;
        Ok(document_signal(
            &self.detect_rgb(&image)?,
            image.width(),
            image.height(),
        ))
    }
}

/// Four-neighbour components (as scipy.ndimage.label in the reference), without OpenCV.
pub(super) fn db_boxes(
    prob: &[f32],
    w: usize,
    h: usize,
    original_w: u32,
    original_h: u32,
) -> Vec<TextBox> {
    let mut seen = vec![false; prob.len()];
    let mut stack = Vec::new();
    let mut boxes = Vec::new();
    for start in 0..prob.len() {
        if seen[start] || prob[start] <= 0.3 || !prob[start].is_finite() {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
        let (mut sum, mut count) = (0., 0usize);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
            sum += prob[i];
            count += 1;
            for next in [
                x.checked_sub(1).map(|_| i - 1),
                (x + 1 < w).then_some(i + 1),
                y.checked_sub(1).map(|_| i - w),
                (y + 1 < h).then_some(i + w),
            ]
            .into_iter()
            .flatten()
            {
                if !seen[next] && prob[next] > 0.3 && prob[next].is_finite() {
                    seen[next] = true;
                    stack.push(next);
                }
            }
        }
        let score = sum / count as f32;
        if score < 0.5 || x1 - x0 < 3 || y1 - y0 < 3 {
            continue;
        }
        let bbox = unclip(
            [x0 as f32, y0 as f32, (x1 - x0) as f32, (y1 - y0) as f32],
            w as f32,
            h as f32,
        );
        let fx = original_w as f32 / w as f32;
        let fy = original_h as f32 / h as f32;
        boxes.push(TextBox {
            bbox: [bbox[0] * fx, bbox[1] * fy, bbox[2] * fx, bbox[3] * fy],
            score,
        });
    }
    boxes.sort_by(|a, b| {
        a.bbox[1]
            .total_cmp(&b.bbox[1])
            .then(a.bbox[0].total_cmp(&b.bbox[0]))
    });
    boxes
}
