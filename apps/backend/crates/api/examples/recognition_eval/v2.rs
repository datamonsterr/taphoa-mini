//! Retrieval v2 preprocessing and voting, kept local to the harness so the eval
//! can score it without touching runtime code. R2 moves the production copies.
use image::{RgbImage, imageops::FilterType};
use std::collections::HashMap;
use taphoa_api::vector::VectorHit;
use taphoa_recognition::{DinoEmbedder, EmbedError, Embedder, crop};
use uuid::Uuid;

/// Rounded ImageNet mean colour used for letterbox padding.
pub const LETTERBOX_BACKGROUND: image::Rgb<u8> = image::Rgb([124, 116, 104]);
const VOTES_PER_PRODUCT: usize = 3;
const DEFAULT_EMBED_KNN: usize = 20;
const KNN_OVERFETCH: usize = 8;
const KNN_OVERFETCH_FLOOR: usize = 32;
const MAX_PRODUCT_REFERENCE_VECTORS: usize = 8 * 2 * 7;

fn fit_dimensions(image: &RgbImage, longest: u32) -> (u32, u32) {
    let scale = f64::from(longest) / f64::from(image.width().max(image.height()).max(1));
    (
        (f64::from(image.width()) * scale).round().max(1.) as u32,
        (f64::from(image.height()) * scale).round().max(1.) as u32,
    )
}

/// Aspect-preserving resize centred on a mean-coloured square.
pub fn letterbox(image: &RgbImage, side: u32) -> RgbImage {
    let (width, height) = fit_dimensions(image, side);
    let resized = image::imageops::resize(image, width, height, FilterType::CatmullRom);
    let mut out = RgbImage::from_pixel(side, side, LETTERBOX_BACKGROUND);
    image::imageops::replace(
        &mut out,
        &resized,
        i64::from((side - width) / 2),
        i64::from((side - height) / 2),
    );
    out
}

/// DINOv2 embedder that letterboxes every crop to 224 px before inference.
pub struct LetterboxedDino(pub DinoEmbedder);
impl Embedder for LetterboxedDino {
    fn model(&self) -> &str {
        self.0.model()
    }
    fn dim(&self) -> usize {
        self.0.dim()
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
        let squares: Vec<_> = crops.iter().map(|c| letterbox(c, 224)).collect();
        self.0.embed_crops(&squares)
    }
}

/// Seven deterministic index views, or just the original when disabled.
pub fn index_augmentations(image: &RgbImage, enabled: bool) -> Vec<(&'static str, RgbImage)> {
    let mut views = vec![("original", image.clone())];
    if !enabled {
        return views;
    }
    let (width, height) = image.dimensions();
    let ratio = 0.7_f64.sqrt();
    let cw = (f64::from(width) * ratio).round().max(1.) as u32;
    let ch = (f64::from(height) * ratio).round().max(1.) as u32;
    let (fw, fh) = fit_dimensions(image, width.max(height).min(48));
    let small = image::imageops::resize(image, fw, fh, FilterType::CatmullRom);
    views.extend([
        ("rotate90", image::imageops::rotate90(image)),
        ("rotate180", image::imageops::rotate180(image)),
        ("rotate270", image::imageops::rotate270(image)),
        (
            "occlude_tl",
            image::imageops::crop_imm(image, 0, 0, cw, ch).to_image(),
        ),
        (
            "occlude_br",
            image::imageops::crop_imm(image, width - cw, height - ch, cw, ch).to_image(),
        ),
        (
            "far48",
            image::imageops::resize(&small, width, height, FilterType::CatmullRom),
        ),
    ]);
    views
}

fn embed_knn() -> usize {
    std::env::var("EMBED_KNN")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or(DEFAULT_EMBED_KNN)
}

fn search_limits(limit: usize, knn: usize) -> (usize, usize) {
    let votes = knn.max(limit.saturating_mul(VOTES_PER_PRODUCT));
    (
        votes
            .saturating_mul(KNN_OVERFETCH)
            .max(limit.saturating_mul(MAX_PRODUCT_REFERENCE_VECTORS))
            .max(KNN_OVERFETCH_FLOOR),
        votes,
    )
}

/// Capped per-product voting over reference hits, with prototype fallback.
pub fn voting_scores(
    mut references: Vec<VectorHit>,
    prototypes: Vec<VectorHit>,
    limit: usize,
) -> Vec<VectorHit> {
    let (fetch, budget) = search_limits(limit, embed_knn());
    let order = |a: &VectorHit, b: &VectorHit| {
        b.similarity
            .total_cmp(&a.similarity)
            .then_with(|| a.product_id.cmp(&b.product_id))
    };
    references.sort_by(order);
    references.truncate(fetch);
    let mut counts = HashMap::<Uuid, usize>::new();
    let mut scores = HashMap::<Uuid, f32>::new();
    let mut votes = 0;
    for hit in references {
        let count = counts.entry(hit.product_id).or_default();
        if *count == VOTES_PER_PRODUCT {
            continue;
        }
        if votes == budget {
            break;
        }
        *count += 1;
        votes += 1;
        *scores.entry(hit.product_id).or_default() += hit.similarity / VOTES_PER_PRODUCT as f32;
    }
    for hit in prototypes {
        scores.entry(hit.product_id).or_insert(hit.similarity);
    }
    let mut hits: Vec<_> = scores
        .into_iter()
        .map(|(product_id, similarity)| VectorHit {
            product_id,
            similarity,
        })
        .collect();
    hits.sort_by(order);
    hits.truncate(limit);
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_is_square_and_centred() {
        let out = letterbox(&RgbImage::from_pixel(100, 50, image::Rgb([0, 0, 0])), 224);
        assert_eq!(out.dimensions(), (224, 224));
        assert_eq!(*out.get_pixel(0, 0), LETTERBOX_BACKGROUND);
        assert_eq!(*out.get_pixel(112, 112), image::Rgb([0, 0, 0]));
    }

    #[test]
    fn augmentations_are_seven_deterministic_views() {
        let image = RgbImage::from_fn(100, 200, |x, y| image::Rgb([x as u8, y as u8, 7]));
        let views = index_augmentations(&image, true);
        assert_eq!(views.len(), 7);
        assert_eq!(views[1].1.dimensions(), (200, 100));
        assert_eq!(index_augmentations(&image, false).len(), 1);
    }

    #[test]
    fn voting_caps_votes_and_falls_back_to_prototypes() {
        let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let hit = |product_id, similarity| VectorHit {
            product_id,
            similarity,
        };
        let refs = vec![hit(a, 0.9), hit(a, 0.9), hit(a, 0.9), hit(a, 0.9)];
        let out = voting_scores(refs, vec![hit(b, 0.4)], 5);
        assert_eq!(out[0].product_id, a);
        assert!((out[0].similarity - 0.9).abs() < 1e-6);
        assert_eq!(out[1].product_id, b);
    }
}
