//! Class-agnostic segmentation. Call synchronous adapters from `spawn_blocking`.
pub mod crop;
pub mod embed;
mod sam;
pub use embed::{DinoEmbedder, EmbedError, Embedder, MockEmbedder};
pub use sam::{
    ImageEncoding, MockPointSegmenter, PointSegment, PointSegmenter, SamOptions, SamSegmenter,
    SegmentTimings,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    /// x, y, width, height in the original image's pixels.
    pub bbox: [f32; 4],
    pub score: f32,
    /// Number of foreground pixels in the original image.
    pub area: u32,
}

/// A point prompt in photo pixel coordinates.
/// `label` 1 = foreground, 0 = background.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PointPrompt {
    pub x: f32,
    pub y: f32,
    pub label: u8,
}

#[derive(Debug, thiserror::Error)]
pub enum SegmentError {
    #[error("invalid image: {0}")]
    InvalidImage(String),
    #[error("inference failed: {0}")]
    Inference(String),
    #[error("not implemented (phase 2)")]
    NotImplemented,
    #[error("invalid prompt: {0}")]
    InvalidPrompt(String),
}

/// Validates point prompts against photo dimensions.
///
/// Requirements:
/// - 1..=2 points
/// - All labels in {0, 1}
/// - At least one foreground label (label == 1)
/// - All coordinates finite and within [0, width) x [0, height)
pub fn validate_points(
    points: &[PointPrompt],
    width: u32,
    height: u32,
) -> Result<(), SegmentError> {
    if points.is_empty() || points.len() > 2 {
        return Err(SegmentError::InvalidPrompt(format!(
            "expected 1 or 2 points, got {}",
            points.len()
        )));
    }
    for p in points {
        if p.label > 1 {
            return Err(SegmentError::InvalidPrompt(format!(
                "label must be 0 or 1, got {}",
                p.label
            )));
        }
        if !p.x.is_finite() || !p.y.is_finite() {
            return Err(SegmentError::InvalidPrompt(
                "coordinates must be finite".into(),
            ));
        }
        if p.x < 0.0 || p.x >= width as f32 || p.y < 0.0 || p.y >= height as f32 {
            return Err(SegmentError::InvalidPrompt(format!(
                "point ({}, {}) out of image bounds {}x{}",
                p.x, p.y, width, height
            )));
        }
    }
    if !points.iter().any(|p| p.label == 1) {
        return Err(SegmentError::InvalidPrompt(
            "at least one foreground point (label 1) required".into(),
        ));
    }
    Ok(())
}

pub trait Segmenter: Send + Sync {
    fn segment(&self, image: &[u8]) -> Result<Vec<Segment>, SegmentError>;
}

pub struct YoloSegmenter;
impl Segmenter for YoloSegmenter {
    fn segment(&self, _image: &[u8]) -> Result<Vec<Segment>, SegmentError> {
        Err(SegmentError::NotImplemented)
    }
}

/// Deterministic adapter for router tests; never selected by production config.
#[derive(Default)]
pub struct MockSegmenter {
    pub segments: Vec<Segment>,
}
impl Segmenter for MockSegmenter {
    fn segment(&self, _image: &[u8]) -> Result<Vec<Segment>, SegmentError> {
        Ok(self.segments.clone())
    }
}

/// Spinning keeps ONNX Runtime worker threads busy instead of parking them, which
/// is why it defaults to OFF: our container CPU quota throttles busy-waiting.
pub fn ort_spinning_from(value: Option<&str>) -> bool {
    matches!(value, Some(v) if v == "1" || v.eq_ignore_ascii_case("true"))
}

pub fn ort_spinning() -> bool {
    ort_spinning_from(std::env::var("ORT_SPINNING").ok().as_deref())
}

/// ONNX Runtime allows one environment per process; SAM and the embedder share it.
pub(crate) fn ort_environment() -> Result<ort::environment::Environment, String> {
    static ENVIRONMENT: std::sync::OnceLock<Result<ort::environment::Environment, String>> =
        std::sync::OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| {
            // Explicit loading reports a missing runtime as an error before any tensor call.
            let library =
                std::env::var("ORT_DYLIB_PATH").unwrap_or_else(|_| "libonnxruntime.so".into());
            ort::init_from(library)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())
        })
        .clone()
}

pub fn bbox_iou(a: [f32; 4], b: [f32; 4]) -> f32 {
    let width = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let height = (a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1]);
    let intersection = width.max(0.0) * height.max(0.0);
    let union = a[2] * a[3] + b[2] * b[3] - intersection;
    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

pub fn filter_and_nms(
    mut segments: Vec<Segment>,
    options: &SamOptions,
    image_area: u64,
) -> Vec<Segment> {
    segments.retain(|s| {
        s.score.is_finite()
            && s.score >= options.min_score
            && s.area >= options.min_area
            && f64::from(s.area) <= image_area as f64 * f64::from(options.max_area_ratio)
            && s.bbox.iter().all(|v| v.is_finite())
            && s.bbox[2] > 0.0
            && s.bbox[3] > 0.0
    });
    segments.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Segment> = Vec::new();
    for candidate in segments {
        if kept
            .iter()
            .all(|s| bbox_iou(s.bbox, candidate.bbox) <= options.nms_iou)
        {
            kept.push(candidate);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    fn segment(bbox: [f32; 4], score: f32, area: u32) -> Segment {
        Segment { bbox, score, area }
    }

    fn fg(x: f32, y: f32) -> PointPrompt {
        PointPrompt { x, y, label: 1 }
    }
    fn bg(x: f32, y: f32) -> PointPrompt {
        PointPrompt { x, y, label: 0 }
    }

    #[test]
    fn iou_handles_overlap_disjoint_and_empty() {
        assert_eq!(bbox_iou([0., 0., 10., 10.], [0., 0., 10., 10.]), 1.0);
        assert!((bbox_iou([0., 0., 10., 10.], [5., 0., 10., 10.]) - 1.0 / 3.0).abs() < 1e-6);
        assert_eq!(bbox_iou([0., 0., 1., 1.], [2., 2., 1., 1.]), 0.0);
        assert_eq!(bbox_iou([0.; 4], [0.; 4]), 0.0);
    }

    #[test]
    fn filters_score_area_background_and_nonfinite_then_suppresses_duplicates() {
        let options = SamOptions::default();
        let candidates = vec![
            segment([0., 0., 10., 10.], 0.95, 100),
            segment([1., 0., 10., 10.], 0.90, 100),
            segment([40., 0., 10., 10.], 0.94, 100),
            segment([60., 0., 10., 10.], 0.1, 100),
            segment([80., 0., 1., 1.], 0.99, 1),
            segment([0., 0., 100., 100.], 0.99, 10000),
            segment([0., 0., 10., 10.], f32::NAN, 100),
        ];
        let kept = filter_and_nms(candidates, &options, 10000);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].score, 0.95);
        assert_eq!(kept[1].bbox[0], 40.0);
    }

    #[test]
    fn yolo_is_explicitly_unimplemented() {
        assert_eq!(
            YoloSegmenter.segment(&[]).unwrap_err().to_string(),
            "not implemented (phase 2)"
        );
    }

    #[test]
    fn ort_spinning_defaults_off_and_accepts_only_explicit_on() {
        assert!(!ort_spinning_from(None));
        assert!(!ort_spinning_from(Some("0")));
        assert!(!ort_spinning_from(Some("yes")));
        assert!(ort_spinning_from(Some("1")));
        assert!(ort_spinning_from(Some("true")));
    }

    // ---- validate_points unit tests ----

    #[test]
    fn validate_points_rejects_zero_points() {
        assert!(matches!(
            validate_points(&[], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
    }

    #[test]
    fn validate_points_rejects_three_points() {
        let pts = [fg(100., 100.), fg(200., 200.), fg(300., 300.)];
        assert!(matches!(
            validate_points(&pts, 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
    }

    #[test]
    fn validate_points_rejects_label_2() {
        let bad = PointPrompt {
            x: 100.,
            y: 100.,
            label: 2,
        };
        assert!(matches!(
            validate_points(&[bad], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
    }

    #[test]
    fn validate_points_rejects_all_background() {
        let pts = [bg(100., 100.), bg(200., 200.)];
        assert!(matches!(
            validate_points(&pts, 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
    }

    #[test]
    fn validate_points_rejects_out_of_range_coords() {
        // x >= width
        assert!(matches!(
            validate_points(&[fg(1600., 100.)], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
        // y >= height
        assert!(matches!(
            validate_points(&[fg(100., 1200.)], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
        // negative
        assert!(matches!(
            validate_points(&[fg(-1., 100.)], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
    }

    #[test]
    fn validate_points_rejects_non_finite_coords() {
        assert!(matches!(
            validate_points(&[fg(f32::NAN, 100.)], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
        assert!(matches!(
            validate_points(&[fg(f32::INFINITY, 100.)], 1600, 1200),
            Err(SegmentError::InvalidPrompt(_))
        ));
    }

    #[test]
    fn validate_points_accepts_valid_single_foreground() {
        assert!(validate_points(&[fg(800., 600.)], 1600, 1200).is_ok());
    }

    #[test]
    fn validate_points_accepts_fg_bg_pair() {
        assert!(validate_points(&[fg(800., 600.), bg(400., 300.)], 1600, 1200).is_ok());
    }

    #[test]
    fn validate_points_accepts_max_coord_minus_epsilon() {
        // x = 1599.9 is inside 1600-wide image
        assert!(validate_points(&[fg(1599.9, 1199.9)], 1600, 1200).is_ok());
    }
}
