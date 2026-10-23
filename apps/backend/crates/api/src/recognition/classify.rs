//! Pure scan pipeline logic: thresholds, duplicate suppression, display order
//! and single-item selection. Deterministic and unit tested; `service` does I/O.
use anyhow::Context;
use serde::Serialize;
use taphoa_recognition::{Segment, bbox_iou};
use uuid::Uuid;

pub const DEFAULT_MATCH_THRESHOLD: f32 = 0.80;
pub const DEFAULT_MATCH_MARGIN: f32 = 0.05;
pub const DEFAULT_MATCH_FLOOR: f32 = 0.60;
pub const DEFAULT_DUPLICATE_THRESHOLD: f32 = 0.88;
pub const DEFAULT_MAX_DETECTIONS: usize = 24;

/// Two vertical centres less than this share of the smaller box height apart
/// land in the same display row.
const ROW_TOLERANCE_RATIO: f32 = 0.5;

pub const MATCH_THRESHOLD: &str = "MATCH_THRESHOLD";
pub const MATCH_MARGIN: &str = "MATCH_MARGIN";
pub const MATCH_FLOOR: &str = "MATCH_FLOOR";
pub const DUPLICATE_THRESHOLD: &str = "DUPLICATE_THRESHOLD";
pub const SCAN_MAX_DETECTIONS: &str = "SCAN_MAX_DETECTIONS";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecognitionConfig {
    pub match_threshold: f32,
    pub match_margin: f32,
    pub match_floor: f32,
    /// Enrollment runs the same classification with this threshold (C2).
    pub duplicate_threshold: f32,
    pub max_detections: usize,
}
impl Default for RecognitionConfig {
    fn default() -> Self {
        Self {
            match_threshold: DEFAULT_MATCH_THRESHOLD,
            match_margin: DEFAULT_MATCH_MARGIN,
            match_floor: DEFAULT_MATCH_FLOOR,
            duplicate_threshold: DEFAULT_DUPLICATE_THRESHOLD,
            max_detections: DEFAULT_MAX_DETECTIONS,
        }
    }
}
impl RecognitionConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let ratio = |name: &str, default: f32| -> anyhow::Result<f32> {
            match get(name) {
                None => Ok(default),
                Some(value) => {
                    let parsed: f32 = value
                        .parse()
                        .with_context(|| format!("{name} must be a number"))?;
                    anyhow::ensure!(
                        (0.0..=1.0).contains(&parsed),
                        "{name} must be within [0, 1]"
                    );
                    Ok(parsed)
                }
            }
        };
        let match_threshold = ratio(MATCH_THRESHOLD, DEFAULT_MATCH_THRESHOLD)?;
        let match_margin = ratio(MATCH_MARGIN, DEFAULT_MATCH_MARGIN)?;
        let match_floor = ratio(MATCH_FLOOR, DEFAULT_MATCH_FLOOR)?;
        let duplicate_threshold = ratio(DUPLICATE_THRESHOLD, DEFAULT_DUPLICATE_THRESHOLD)?;
        anyhow::ensure!(
            match_floor <= match_threshold,
            "{MATCH_FLOOR} must not exceed {MATCH_THRESHOLD}"
        );
        let max_detections = match get(SCAN_MAX_DETECTIONS) {
            None => DEFAULT_MAX_DETECTIONS,
            Some(value) => {
                let parsed: usize = value
                    .parse()
                    .with_context(|| format!("{SCAN_MAX_DETECTIONS} must be an integer"))?;
                anyhow::ensure!(parsed > 0, "{SCAN_MAX_DETECTIONS} must be positive");
                parsed
            }
        };
        Ok(Self {
            match_threshold,
            match_margin,
            match_floor,
            duplicate_threshold,
            max_detections,
        })
    }
}

/// Silence is a Rust keyword; the JSON field is renamed to `match`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchClass {
    Matched,
    Ambiguous,
    Unknown,
}
impl std::fmt::Display for MatchClass {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Matched => "matched",
            Self::Ambiguous => "ambiguous",
            Self::Unknown => "unknown",
        };
        formatter.write_str(name)
    }
}

/// `matched`: top similarity reaches the threshold with the configured margin
/// over the runner-up; else `ambiguous`: at or above the floor; else `unknown`.
/// Runner-up `None` (single hit or empty list) satisfies the margin.
pub fn classify(
    top: Option<f32>,
    runner_up: Option<f32>,
    threshold: f32,
    margin: f32,
    floor: f32,
) -> MatchClass {
    let Some(score) = top else {
        return MatchClass::Unknown;
    };
    let clear = runner_up.is_none_or(|runner| score - runner >= margin);
    if score >= threshold && clear {
        MatchClass::Matched
    } else if score >= floor {
        MatchClass::Ambiguous
    } else {
        MatchClass::Unknown
    }
}

/// Repeats of one product's top candidate overlap so strongly that the smaller
/// crop duplicates the kept detection; `unknown` detections survive always.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DedupeKey {
    pub score: f32,
    pub bbox: [f32; 4],
    pub top_product: Option<Uuid>,
    pub class: MatchClass,
}

pub fn dedupe<T: Clone>(items: Vec<T>, key: impl Fn(&T) -> DedupeKey) -> Vec<T> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    let keys: Vec<DedupeKey> = items.iter().map(&key).collect();
    order.sort_by(|&a, &b| keys[b].score.total_cmp(&keys[a].score));
    let mut kept: Vec<(usize, [f32; 4], Uuid)> = Vec::new();
    for index in order {
        let entry = &keys[index];
        let drop_name = entry
            .top_product
            .filter(|_| entry.class != MatchClass::Unknown)
            .is_some_and(|product| {
                kept.iter().any(|(_, kept_box, kept_product)| {
                    *kept_product == product && bbox_iou(*kept_box, entry.bbox) > 0.5
                })
            });
        if drop_name {
            continue;
        }
        kept.push((index, entry.bbox, entry.top_product.unwrap_or_default()));
    }
    kept.into_iter()
        .map(|(index, ..)| items[index].clone())
        .collect()
}

/// Row-major left-to-right display order: centres are grouped into rows
/// (vertical distance tolerance relative to box height), rows top-to-bottom,
/// items left-to-right. Returns the sequence of indexes in that order.
pub fn order_row_major(boxes: &[[f32; 4]]) -> Vec<usize> {
    let centre_y = |box_: &[f32; 4]| box_[1] + box_[3] / 2.0;
    let centre_x = |box_: &[f32; 4]| box_[0] + box_[2] / 2.0;
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut sorted: Vec<usize> = (0..boxes.len()).collect();
    sorted.sort_by(|&a, &b| centre_y(&boxes[a]).total_cmp(&centre_y(&boxes[b])));
    for index in sorted {
        let height = boxes[index][3];
        if let Some(row) = rows.last_mut()
            && let Some(anchor) = row.first()
        {
            let (reference, reference_height) = (centre_y(&boxes[*anchor]), boxes[*anchor][3]);
            if centre_y(&boxes[index]) - reference
                <= ROW_TOLERANCE_RATIO * reference_height.min(height)
            {
                row.push(index);
                continue;
            }
        }
        rows.push(vec![index]);
    }
    rows.into_iter()
        .flat_map(|row| {
            let mut row = row;
            row.sort_by(|&a, &b| centre_x(&boxes[a]).total_cmp(&centre_x(&boxes[b])));
            row
        })
        .collect()
}

/// Whole-image box for `single` mode when no segment is found.
pub fn whole_image_box(width: u32, height: u32) -> Segment {
    Segment {
        bbox: [0.0, 0.0, width as f32, height as f32],
        score: 0.0,
        area: width.saturating_mul(height),
    }
}

/// `single` mode: the largest segment, weighted toward the image centre
/// (per architecture 5.3), or `None` when no candidate is usable.
pub fn pick_single(segments: &[Segment], width: u32, height: u32) -> Option<Segment> {
    let half_diagonal = ((f64::from(width) / 2.0).powi(2) + (f64::from(height) / 2.0).powi(2))
        .sqrt()
        .max(1.0);
    let centre_x = f64::from(width) / 2.0;
    let centre_y = f64::from(height) / 2.0;
    segments
        .iter()
        .filter(|segment| {
            segment.bbox.iter().all(|value| value.is_finite())
                && segment.bbox[2] > 0.0
                && segment.bbox[3] > 0.0
        })
        .cloned()
        .max_by(|a, b| {
            let weight = |segment: &Segment| {
                let (x, y) = (
                    f64::from(segment.bbox[0] + segment.bbox[2] / 2.0),
                    f64::from(segment.bbox[1] + segment.bbox[3] / 2.0),
                );
                let distance = ((x - centre_x).powi(2) + (y - centre_y).powi(2)).sqrt();
                // Mild centrality: pixel area stays the dominant signal, the
                // image-centre term breaks ties and near-ties.
                f64::from(segment.area) * (1.0 - 0.25 * distance / half_diagonal)
            };
            weight(a).total_cmp(&weight(b))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(threshold: f32, margin: f32, floor: f32) -> (f32, f32, f32) {
        (threshold, margin, floor)
    }

    #[test]
    fn classify_matches_only_up_to_threshold_with_margin() {
        let (t, m, f) = test_config(0.80, 0.05, 0.60);
        // No candidates at all is unknown.
        assert_eq!(classify(None, None, t, m, f), MatchClass::Unknown);
        // Boundary: exactly at threshold and margin is matched.
        assert_eq!(
            classify(Some(0.80), Some(0.75), t, m, f),
            MatchClass::Matched
        );
        assert_eq!(classify(Some(0.80), None, t, m, f), MatchClass::Matched);
        // Just inside the threshold and a hair under the margin is ambiguous.
        assert_eq!(classify(Some(0.799), None, t, m, f), MatchClass::Ambiguous);
        assert_eq!(
            classify(Some(0.80), Some(0.750_1), t, m, f),
            MatchClass::Ambiguous
        );
        // Ambiguous band reaches exactly to the floor.
        assert_eq!(classify(Some(0.60), None, t, m, f), MatchClass::Ambiguous);
        assert_eq!(classify(Some(0.599_9), None, t, m, f), MatchClass::Unknown);
        // A very negative runner-up keeps margin satisfied.
        assert_eq!(
            classify(Some(0.9), Some(-1.0), t, m, f),
            MatchClass::Matched
        );
        // Enrollment-style threshold (duplicate check).
        assert_eq!(classify(Some(0.88), None, 0.88, m, f), MatchClass::Matched);
        assert_eq!(
            classify(Some(0.879_9), None, 0.88, m, f),
            MatchClass::Ambiguous
        );
        // A zero margin config does not demote equal runner-ups.
        assert_eq!(
            classify(Some(0.9), Some(0.9), t, 0.0, f),
            MatchClass::Matched
        );
    }

    #[test]
    fn config_env_parsing_validates_ranges() {
        let defaults = RecognitionConfig::from_lookup(|_| None).unwrap();
        assert_eq!(
            defaults,
            RecognitionConfig {
                match_threshold: 0.80,
                match_margin: 0.05,
                match_floor: 0.60,
                duplicate_threshold: 0.88,
                max_detections: 24
            }
        );
        let parsed = RecognitionConfig::from_lookup(|name| match name {
            MATCH_THRESHOLD => Some("0.9".into()),
            MATCH_MARGIN => Some("0.2".into()),
            MATCH_FLOOR => Some("0.7".into()),
            DUPLICATE_THRESHOLD => Some("0.95".into()),
            SCAN_MAX_DETECTIONS => Some("3".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(parsed.match_threshold, 0.9);
        assert_eq!(parsed.match_margin, 0.2);
        assert_eq!(parsed.match_floor, 0.7);
        assert_eq!(parsed.duplicate_threshold, 0.95);
        assert_eq!(parsed.max_detections, 3);
        for (name, value) in [
            (MATCH_THRESHOLD, "1.01"),
            (MATCH_THRESHOLD, "-0.1"),
            (MATCH_THRESHOLD, "abc"),
            (MATCH_MARGIN, "-0.01"),
            (MATCH_MARGIN, "1.01"),
            (MATCH_FLOOR, "1.1"),
            (DUPLICATE_THRESHOLD, "2"),
        ] {
            assert!(
                RecognitionConfig::from_lookup(|key| (key == name).then(|| value.into())).is_err(),
                "{name}={value} must be rejected"
            );
        }
        // Floor above threshold is rejected.
        assert!(
            RecognitionConfig::from_lookup(|name| match name {
                MATCH_THRESHOLD => Some("0.5".into()),
                MATCH_FLOOR => Some("0.9".into()),
                _ => None,
            })
            .is_err()
        );
    }

    fn segment(bbox: [f32; 4], score: f32, area: u32) -> Segment {
        Segment { bbox, score, area }
    }

    #[test]
    fn pick_single_weights_area_toward_the_image_centre() {
        let segments = vec![
            segment([0., 0., 100., 100.], 0.9, 10_000),
            segment([150., 0., 100., 100.], 0.8, 10_000),
        ];
        // Same area; the central one wins (image 300x100).
        let picked = pick_single(&segments, 300, 100).unwrap();
        assert_eq!(picked.bbox, [150., 0., 100., 100.]);
        // A much larger area wins over centrality.
        let big = vec![
            segment([0., 0., 100., 100.], 0.9, 10_000),
            segment([120., 0., 140., 90.], 0.8, 8_000),
        ];
        let picked = pick_single(&big, 300, 100).unwrap();
        assert_eq!(picked.bbox, [0., 0., 100., 100.]);
        // Empty or unusable segments have no pick; the caller falls back.
        assert!(pick_single(&[], 300, 100).is_none());
        assert!(pick_single(&[segment([0., 0., 0., 0.], 0.9, 0)], 300, 100).is_none());
        // Whole-image fallback box.
        assert_eq!(whole_image_box(800, 200).bbox, [0., 0., 800., 200.]);
        assert_eq!(whole_image_box(800, 200).area, 160_000);
        assert_eq!(whole_image_box(800, 200).score, 0.0);
    }

    #[test]
    fn order_row_major_sorts_rows_top_to_bottom_and_columns_left_to_right() {
        // (x, y) of 60 px boxes: one top row and one bottom row.
        let boxes: [[f32; 4]; 5] = [
            [120., 20., 60., 60.],
            [0., 30., 60., 60.],
            [60., 110., 60., 60.],
            [180., 25., 60., 60.],
            [10., 110., 60., 60.],
        ];
        // Rows: top (y≈50) boxes 0,1,3 reading left-to-right 1,0,3; bottom
        // (y≈140) boxes 2,4 reading left-to-right 4,2.
        assert_eq!(order_row_major(&boxes), vec![1, 0, 3, 4, 2]);
    }

    #[test]
    fn row_tolerance_keeps_staggered_boxes_in_one_row() {
        // Vertically staggered but within half the smaller box height: one row.
        let boxes: [[f32; 4]; 2] = [[0., 0., 100., 100.], [120., 40., 100., 60.]];
        assert_eq!(order_row_major(&boxes), vec![0, 1]);
        // Beyond the tolerance: separate rows, top row first.
        let boxes: [[f32; 4]; 2] = [[0., 0., 100., 100.], [120., 60., 100., 60.]];
        assert_eq!(order_row_major(&boxes), vec![0, 1]);
        // Same two boxes again, but the bottom row sits to the left: rows are
        // still read top-to-bottom, left-to-right.
        let boxes: [[f32; 4]; 2] = [[120., 0., 100., 60.], [0., 60., 60., 60.]];
        assert_eq!(order_row_major(&boxes), vec![0, 1]);
    }

    fn dedupe_key(
        score: f32,
        bbox: [f32; 4],
        product: Option<Uuid>,
        class: MatchClass,
    ) -> DedupeKey {
        DedupeKey {
            score,
            bbox,
            top_product: product,
            class,
        }
    }

    #[test]
    fn dedupe_drops_repeats_of_one_product_beyond_half_iou() {
        let product = Uuid::new_v4();
        let other = Uuid::new_v4();
        // (score, bbox, top product, class); index order is unrelated to score.
        let keys = vec![
            dedupe_key(
                0.9,
                [0., 0., 100., 100.],
                Some(product),
                MatchClass::Matched,
            ),
            dedupe_key(
                0.8,
                [10., 10., 90., 90.],
                Some(product),
                MatchClass::Matched,
            ),
            dedupe_key(
                0.7,
                [200., 0., 10., 10.],
                Some(other),
                MatchClass::Ambiguous,
            ),
            dedupe_key(0.6, [31., 31., 100., 100.], None, MatchClass::Unknown),
        ];
        let kept = dedupe(keys.clone(), |key| *key);
        assert_eq!(kept, vec![keys[0], keys[2], keys[3]]);
    }

    #[test]
    fn dedupe_keeps_overlap_of_different_products_and_unknowns() {
        let product = Uuid::new_v4();
        let keys = vec![
            // Same box, different top products: both stay. `unknown` items
            // (no top product) are never dropped as duplicates.
            dedupe_key(
                0.9,
                [0., 0., 100., 100.],
                Some(product),
                MatchClass::Matched,
            ),
            dedupe_key(0.8, [1., 1., 100., 100.], None, MatchClass::Unknown),
            dedupe_key(0.5, [2., 2., 100., 100.], None, MatchClass::Unknown),
        ];
        let kept = dedupe(keys.clone(), |key| *key);
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn dedupe_orders_results_by_score_descending() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let keys = vec![
            dedupe_key(0.55, [0., 0., 1., 1.], Some(a), MatchClass::Matched),
            dedupe_key(0.95, [5., 5., 1., 1.], Some(b), MatchClass::Matched),
            dedupe_key(0.75, [9., 9., 1., 1.], Some(a), MatchClass::Matched),
        ];
        let kept = dedupe(keys.clone(), |key| *key);
        assert_eq!(kept, vec![keys[1], keys[2], keys[0]]);
    }
}
