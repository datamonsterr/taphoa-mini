//! Vietnamese receipt OCR on the shared ONNX Runtime. Call adapters from `spawn_blocking`.
mod detector;
mod viet;
pub use detector::PpOcrDetector;
pub use viet::VietOcr;

use image::RgbImage;
use ort::session::{Session, builder::GraphOptimizationLevel};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextBox {
    /// x, y, width, height in original image pixels (including diacritic padding).
    pub bbox: [f32; 4],
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcrLine {
    pub text: String,
    /// x, y, width, height in original image pixels.
    pub bbox: [f32; 4],
    /// Mean maximum probability of decoded character tokens, excluding EOS.
    pub confidence: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentSignal {
    pub detected: bool,
    pub score: f32,
    pub text_lines: u32,
    /// Grouped lines in normalized [x, y, width, height] coordinates, at most 40.
    #[serde(default)]
    pub line_boxes: Vec<[f32; 4]>,
}

#[derive(Debug, thiserror::Error)]
pub enum OcrError {
    #[error("invalid image: {0}")]
    InvalidImage(String),
    #[error("OCR inference failed: {0}")]
    Inference(String),
}

/// Synchronous, object-safe port accepting JPEG/PNG bytes, like `Segmenter`.
pub trait TextDetector: Send + Sync {
    fn detect(&self, image: &[u8]) -> Result<Vec<TextBox>, OcrError>;
    fn document_signal(&self, image: &[u8]) -> Result<DocumentSignal, OcrError> {
        let decoded = decode(image)?;
        Ok(document_signal(
            &self.detect(image)?,
            decoded.width(),
            decoded.height(),
        ))
    }
}

pub trait ReceiptOcr: Send + Sync {
    /// Lines ordered top-to-bottom, with columns joined left-to-right by one space.
    fn read_lines(&self, image: &[u8]) -> Result<Vec<OcrLine>, OcrError>;
}

#[derive(Default)]
pub struct FakeTextDetector {
    pub boxes: Vec<TextBox>,
}
impl TextDetector for FakeTextDetector {
    fn detect(&self, _image: &[u8]) -> Result<Vec<TextBox>, OcrError> {
        Ok(self.boxes.clone())
    }
}

#[derive(Default)]
pub struct FakeReceiptOcr {
    pub lines: Vec<OcrLine>,
}
impl ReceiptOcr for FakeReceiptOcr {
    fn read_lines(&self, _image: &[u8]) -> Result<Vec<OcrLine>, OcrError> {
        let mut lines = self.lines.clone();
        lines.sort_by(|a, b| {
            a.bbox[1]
                .total_cmp(&b.bbox[1])
                .then(a.bbox[0].total_cmp(&b.bbox[0]))
        });
        Ok(lines)
    }
}

fn inference(error: impl std::fmt::Display) -> OcrError {
    OcrError::Inference(error.to_string())
}
fn decode(bytes: &[u8]) -> Result<RgbImage, OcrError> {
    crate::crop::decode_limited(bytes)
        .map(|i| i.to_rgb8())
        .map_err(OcrError::InvalidImage)
}
fn session(path: &Path, threads: usize) -> Result<Session, OcrError> {
    let environment = crate::ort_environment().map_err(inference)?;
    Session::builder(&environment)
        .map_err(inference)?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(inference)?
        .with_intra_threads(if threads == 0 { 4 } else { threads })
        .map_err(inference)?
        .with_intra_op_spinning(crate::ort_spinning())
        .map_err(inference)?
        .with_inter_op_spinning(crate::ort_spinning())
        .map_err(inference)?
        .commit_from_file(path)
        .map_err(inference)
}

/// Unclip an axis-aligned DB component using offset = area * 2 / perimeter.
fn unclip([x, y, w, h]: [f32; 4], width: f32, height: f32) -> [f32; 4] {
    let offset = w * h / (w + h);
    let x0 = (x - offset).max(0.);
    let y0 = (y - offset).max(0.);
    let x1 = (x + w + offset).min(width);
    let y1 = (y + h + offset).min(height);
    [x0, y0, x1 - x0, y1 - y0]
}

fn union(boxes: &[TextBox]) -> [f32; 4] {
    let x = boxes
        .iter()
        .map(|b| b.bbox[0])
        .fold(f32::INFINITY, f32::min);
    let y = boxes
        .iter()
        .map(|b| b.bbox[1])
        .fold(f32::INFINITY, f32::min);
    let right = boxes
        .iter()
        .map(|b| b.bbox[0] + b.bbox[2])
        .fold(0., f32::max);
    let bottom = boxes
        .iter()
        .map(|b| b.bbox[1] + b.bbox[3])
        .fold(0., f32::max);
    [x, y, right - x, bottom - y]
}

fn group_lines(mut boxes: Vec<TextBox>) -> Vec<Vec<TextBox>> {
    boxes.sort_by(|a, b| {
        a.bbox[1]
            .total_cmp(&b.bbox[1])
            .then(a.bbox[0].total_cmp(&b.bbox[0]))
    });
    let mut lines: Vec<Vec<TextBox>> = Vec::new();
    for b in boxes {
        let center = b.bbox[1] + b.bbox[3] / 2.;
        let candidate = lines
            .iter()
            .enumerate()
            .filter_map(|(i, line)| {
                // Use the first box as the row anchor: a tall merged union must not bridge rows.
                let a = &line[0].bbox;
                let overlap = (a[1] + a[3]).min(b.bbox[1] + b.bbox[3]) - a[1].max(b.bbox[1]);
                (overlap > 0.5 * a[3].min(b.bbox[3]))
                    .then_some((i, (a[1] + a[3] / 2. - center).abs()))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i);
        if let Some(i) = candidate {
            lines[i].push(b);
        } else {
            lines.push(vec![b]);
        }
    }
    for line in &mut lines {
        line.sort_by(|a, b| a.bbox[0].total_cmp(&b.bbox[0]));
    }
    lines.sort_by(|a, b| {
        let a = union(a);
        let b = union(b);
        a[1].total_cmp(&b[1]).then(a[0].total_cmp(&b[0]))
    });
    lines
}

const DOCUMENT_MIN_LINES: u32 = 6;
const DOCUMENT_MIN_AREA_RATIO: f32 = 0.08;
fn document_signal(boxes: &[TextBox], width: u32, height: u32) -> DocumentSignal {
    let lines = group_lines(boxes.to_vec());
    let text_lines = lines.len() as u32;
    let line_boxes = lines
        .iter()
        .take(40)
        .map(|line| {
            let [x, y, w, h] = union(line);
            let left = (x / width as f32).clamp(0., 1.);
            let top = (y / height as f32).clamp(0., 1.);
            let right = ((x + w) / width as f32).clamp(left, 1.);
            let bottom = ((y + h) / height as f32).clamp(top, 1.);
            [left, top, right - left, bottom - top]
        })
        .collect();
    let ratio =
        boxes.iter().map(|b| b.bbox[2] * b.bbox[3]).sum::<f32>() / (width as f32 * height as f32);
    DocumentSignal {
        detected: text_lines >= DOCUMENT_MIN_LINES && ratio >= DOCUMENT_MIN_AREA_RATIO,
        score: (ratio / 0.2).clamp(0., 1.),
        text_lines,
        line_boxes,
    }
}

#[cfg(test)]
use detector::db_boxes;
#[cfg(test)]
use viet::{Vocab, greedy_decode};

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Vocab {
        serde_json::from_str(r#"{"image_height":32,"image_min_width":32,"image_max_width":512,"max_seq_length":5,"sos":1,"eos":2,"offset":4,"vocab":"aữệ "}"#).unwrap()
    }
    fn b(x: f32, y: f32, w: f32, h: f32) -> TextBox {
        TextBox {
            bbox: [x, y, w, h],
            score: 0.9,
        }
    }
    #[test]
    fn document_signal_requires_both_line_count_and_area() {
        let sparse: Vec<_> = (0..6).map(|i| b(0., i as f32 * 10., 10., 5.)).collect();
        let signal = document_signal(&sparse, 100, 100);
        assert!(!signal.detected);
        assert_eq!(signal.text_lines, 6);
        assert!((signal.score - 0.15).abs() < 1e-6);
        let dense: Vec<_> = (0..5).map(|i| b(0., i as f32 * 20., 100., 15.)).collect();
        assert!(!document_signal(&dense, 100, 100).detected);
        assert_eq!(
            document_signal(&[], 100, 100),
            DocumentSignal {
                detected: false,
                score: 0.,
                text_lines: 0,
                line_boxes: vec![],
            }
        );
        let boundary: Vec<_> = (0..6).map(|i| b(0., i as f32 * 15., 40., 10.)).collect();
        assert!(document_signal(&boundary, 100, 300).detected);
    }
    #[test]
    fn document_line_boxes_group_normalize_clip_sort_and_cap() {
        // Two columns on the same row form one line, even with vertical offsets.
        let signal = document_signal(
            &[
                b(80., 44., 30., 20.),
                b(-10., 40., 40., 20.),
                b(20., -5., 40., 15.),
            ],
            100,
            200,
        );
        assert_eq!(signal.text_lines, 2);
        for (actual, expected) in signal
            .line_boxes
            .iter()
            .flatten()
            .zip([0.2, 0., 0.4, 0.05, 0., 0.2, 1., 0.12])
        {
            assert!((actual - expected).abs() < 1e-6);
        }
        // Count remains the full line count; only the preview geometry is capped.
        let boxes: Vec<_> = (0..45)
            .rev()
            .map(|i| b(50., i as f32 * 20., 80., 15.))
            .collect();
        let signal = document_signal(&boxes, 100, 800);
        assert_eq!(signal.text_lines, 45);
        assert_eq!(signal.line_boxes.len(), 40);
        assert_eq!(signal.line_boxes[0], [0.5, 0., 0.5, 15. / 800.]);
        assert_eq!(signal.line_boxes[39][1], 780. / 800.);
        assert!(
            signal
                .line_boxes
                .windows(2)
                .all(|pair| pair[0][1] <= pair[1][1])
        );
        assert!(
            signal
                .line_boxes
                .iter()
                .flatten()
                .all(|value| (0. ..=1.).contains(value))
        );
        assert_eq!(
            document_signal(&[b(90., 195., 30., 20.)], 100, 200).line_boxes[0],
            [0.9, 0.975, 1. - 0.9, 1. - 0.975]
        );
    }

    #[test]
    fn old_document_signal_defaults_line_boxes_without_losing_detection() {
        let signal: DocumentSignal = serde_json::from_value(serde_json::json!({
            "detected": true, "score": 0.8, "text_lines": 12
        }))
        .unwrap();
        assert!(signal.detected);
        assert_eq!(signal.text_lines, 12);
        assert_eq!(signal.score, 0.8);
        assert!(signal.line_boxes.is_empty());
    }
    #[test]
    fn crop_width_rounds_like_reference_and_clamps() {
        let m = meta();
        assert_eq!(m.width(101, 32), 110);
        assert_eq!(m.width(100, 33), 100);
        assert_eq!(m.width(1, 100), 32);
        assert_eq!(m.width(1000, 1), 512);
    }
    #[test]
    fn db_components_apply_threshold_score_size_and_original_scale() {
        let mut prob = vec![0.; 20 * 12];
        for y in 3..6 {
            for x in 4..9 {
                prob[y * 20 + x] = 0.8;
            }
        }
        // Below score threshold, isolated small component, and exactly mask threshold.
        for y in 8..11 {
            for x in 14..18 {
                prob[y * 20 + x] = 0.4;
            }
        }
        prob[0] = 0.9;
        prob[1] = 0.3;
        let boxes = db_boxes(&prob, 20, 12, 40, 24);
        assert_eq!(boxes.len(), 1);
        assert!((boxes[0].score - 0.8).abs() < 1e-5);
        assert_eq!(boxes[0].bbox, [4.25, 2.25, 17.5, 13.5]);
    }
    #[test]
    fn unclip_uses_area_perimeter_and_clips_edges() {
        for (actual, expected) in unclip([10., 20., 20., 10.], 100., 100.).into_iter().zip([
            10. - 20. / 3.,
            20. - 20. / 3.,
            20. + 40. / 3.,
            10. + 40. / 3.,
        ]) {
            assert!((actual - expected).abs() < 1e-5);
        }
        assert_eq!(unclip([0., 0., 10., 10.], 12., 12.), [0., 0., 12., 12.]);
    }
    #[test]
    fn grouping_merges_columns_orders_rows_and_requires_majority_overlap() {
        let lines = group_lines(vec![
            b(200., 11., 100., 20.),
            b(5., 50., 100., 20.),
            b(5., 10., 80., 20.),
            b(5., 61., 80., 20.),
        ]);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].len(), 2);
        assert_eq!(lines[0][0].bbox[0], 5.);
        assert_eq!(lines[1][0].bbox[1], 50.);
    }
    #[test]
    fn vocab_maps_unicode_chars_and_ignores_special_tokens() {
        let m = meta();
        assert_eq!(m.character(5), Some('ữ'));
        assert_eq!(m.character(6), Some('ệ'));
        assert_eq!(m.character(2), None);
        assert_eq!(m.character(999), None);
    }
    #[test]
    fn greedy_is_batched_stops_at_eos_and_averages_token_probabilities() {
        let m = meta();
        let mut calls = 0;
        let out = greedy_decode(&m, 2, |tgt| {
            if calls == 0 {
                assert_eq!(tgt, &[1, 1]);
            }
            let tokens = [[5, 4], [6, 2], [2, 6]][calls];
            let probability = if calls == 0 { 0.8_f32 } else { 0.6_f32 };
            calls += 1;
            let mut probs = vec![-20.; 2 * 8];
            probs[tokens[0]] = probability.ln();
            probs[8 + tokens[1]] = 0.9_f32.ln();
            Ok(probs)
        })
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(out[0].text, "ữệ");
        assert!((out[0].confidence - 0.7).abs() < 1e-6);
        assert_eq!(out[1].text, "a");
        assert!((out[1].confidence - 0.9).abs() < 1e-6);
    }
    #[test]
    fn greedy_honors_max_length_and_rejects_bad_outputs() {
        let m = meta();
        let out = greedy_decode(&m, 1, |_| {
            let mut v = vec![-20.; 8];
            v[6] = 0.;
            Ok(v)
        })
        .unwrap();
        assert_eq!(out[0].text, "ệệệệệ");
        assert!(greedy_decode(&m, 2, |_| Ok(vec![])).is_err());
        assert!(greedy_decode(&m, 1, |_| Ok(vec![f32::NAN; 8])).is_err());
    }
    #[test]
    fn fake_ports_are_object_safe_and_document_thresholds_use_grouped_lines() {
        let boxes = (0..6).map(|i| b(0., i as f32 * 15., 60., 10.)).collect();
        let detector: Box<dyn TextDetector> = Box::new(FakeTextDetector { boxes });
        let image = image::RgbImage::new(100, 100);
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let signal = detector.document_signal(bytes.get_ref()).unwrap();
        assert!(signal.detected);
        assert_eq!(signal.text_lines, 6);
        assert_eq!(signal.score, 1.);
        let ocr: Box<dyn ReceiptOcr> = Box::new(FakeReceiptOcr {
            lines: vec![OcrLine {
                text: "Sữa".into(),
                bbox: [0.; 4],
                confidence: 1.,
            }],
        });
        assert_eq!(ocr.read_lines(&[]).unwrap()[0].text, "Sữa");
    }
}
