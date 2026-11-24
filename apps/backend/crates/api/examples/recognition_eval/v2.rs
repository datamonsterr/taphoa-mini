//! Retrieval v2 preprocessing and voting, delegating to production copies in runtime crates.
use image::RgbImage;
pub use taphoa_api::vector::voting_scores;
pub use taphoa_recognition::crop::{LETTERBOX_BACKGROUND, index_augmentations, letterbox};
use taphoa_recognition::{DinoEmbedder, EmbedError, Embedder, crop};

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

#[cfg(test)]
mod tests {
    use super::*;
    use taphoa_api::vector::VectorHit;
    use uuid::Uuid;

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
