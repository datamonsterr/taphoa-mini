//! Crop, resize and normalize helpers shared by the embedder and the scan pipeline.
use image::{RgbImage, imageops::FilterType};

/// Side of the square embedder input.
pub const EMBED_SIDE: u32 = 224;
/// ImageNet statistics used by DINOv2.
pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Crops `bbox` (x, y, width, height in pixels) grown by `pad` (fraction of each side, e.g. 0.08)
/// on every edge, clamped to the image. Returns `None` for an empty or non-finite box.
pub fn crop_with_padding(image: &RgbImage, bbox: [f32; 4], pad: f32) -> Option<RgbImage> {
    if bbox.iter().any(|v| !v.is_finite()) || bbox[2] <= 0.0 || bbox[3] <= 0.0 {
        return None;
    }
    let (iw, ih) = (image.width() as f32, image.height() as f32);
    let x0 = (bbox[0] - bbox[2] * pad).floor().clamp(0.0, iw);
    let y0 = (bbox[1] - bbox[3] * pad).floor().clamp(0.0, ih);
    let x1 = (bbox[0] + bbox[2] * (1.0 + pad)).ceil().clamp(0.0, iw);
    let y1 = (bbox[1] + bbox[3] * (1.0 + pad)).ceil().clamp(0.0, ih);
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return None;
    }
    Some(
        image::imageops::crop_imm(
            image,
            x0 as u32,
            y0 as u32,
            (x1 - x0) as u32,
            (y1 - y0) as u32,
        )
        .to_image(),
    )
}

/// Resizes to `EMBED_SIDE` square and writes CHW floats normalized with ImageNet statistics
/// into `out` (length `3 * EMBED_SIDE * EMBED_SIDE`).
pub fn normalize_into(crop: &RgbImage, out: &mut [f32], side_px: u32) {
    let side = side_px as usize;
    debug_assert_eq!(out.len(), 3 * side * side);
    let resized;
    let source = if crop.width() == side_px && crop.height() == side_px {
        crop
    } else {
        resized = image::imageops::resize(crop, side_px, side_px, FilterType::CatmullRom);
        &resized
    };
    for (x, y, pixel) in source.enumerate_pixels() {
        for channel in 0..3 {
            out[channel * side * side + y as usize * side + x as usize] =
                (f32::from(pixel[channel]) / 255.0 - IMAGENET_MEAN[channel])
                    / IMAGENET_STD[channel];
        }
    }
}

/// L2-normalizes in place; a zero vector is left unchanged.
pub fn l2_normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 && norm.is_finite() {
        vector.iter_mut().for_each(|v| *v /= norm);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padding_grows_box_and_clamps_to_image() {
        let image = RgbImage::new(100, 100);
        let crop = crop_with_padding(&image, [20., 20., 50., 50.], 0.08).unwrap();
        assert_eq!((crop.width(), crop.height()), (58, 58));
        let edge = crop_with_padding(&image, [0., 0., 100., 100.], 0.08).unwrap();
        assert_eq!((edge.width(), edge.height()), (100, 100));
    }

    #[test]
    fn rejects_empty_or_nonfinite_boxes() {
        let image = RgbImage::new(10, 10);
        assert!(crop_with_padding(&image, [0., 0., 0., 5.], 0.08).is_none());
        assert!(crop_with_padding(&image, [f32::NAN, 0., 5., 5.], 0.08).is_none());
        assert!(crop_with_padding(&image, [50., 50., 5., 5.], 0.0).is_none());
    }

    #[test]
    fn normalizes_with_imagenet_statistics() {
        let crop = RgbImage::from_pixel(8, 8, image::Rgb([255, 0, 128]));
        let mut out = vec![0.0; 3 * 224 * 224];
        normalize_into(&crop, &mut out, EMBED_SIDE);
        assert!((out[0] - (1.0 - 0.485) / 0.229).abs() < 1e-4);
        assert!((out[224 * 224] - (0.0 - 0.456) / 0.224).abs() < 1e-4);
        assert!((out[2 * 224 * 224 + 5] - (128.0 / 255.0 - 0.406) / 0.225).abs() < 1e-3);
    }

    #[test]
    fn l2_normalize_gives_unit_norm_and_keeps_zero() {
        let mut v = vec![3.0, 4.0];
        l2_normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        let mut z = vec![0.0; 3];
        l2_normalize(&mut z);
        assert_eq!(z, vec![0.0; 3]);
    }
}
