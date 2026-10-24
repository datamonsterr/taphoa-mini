//! Crop, resize and normalize helpers shared by the embedder and the scan pipeline.
use image::{GrayImage, RgbImage, imageops::FilterType};

/// Side of the square embedder input.
pub const EMBED_SIDE: u32 = 224;
/// ImageNet statistics used by DINOv2.
pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Longest accepted edge of a decoded photo.
pub const MAX_DECODE_SIDE: u32 = 4096;
/// A 4096 x 4096 RGBA decode is 64 MiB; nothing legitimate needs more.
pub const MAX_DECODE_ALLOC: u64 = 64 * 1024 * 1024;

/// Image formats the API accepts, from magic bytes (never from the declared type).
pub fn sniff_format(bytes: &[u8]) -> Option<image::ImageFormat> {
    if bytes.starts_with(b"\xff\xd8\xff") {
        Some(image::ImageFormat::Jpeg)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(image::ImageFormat::Png)
    } else {
        None
    }
}

/// Decodes a JPEG or PNG within fixed dimension and allocation limits. Other formats, even
/// ones the `image` crate could guess, are rejected before any decoder runs.
pub fn decode_limited(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    let format = sniff_format(bytes).ok_or("expected a JPEG or PNG image")?;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    reader.decode().map_err(|e| e.to_string())
}

/// Crops `bbox` (x, y, width, height in pixels) grown by `pad` (fraction of each side, e.g. 0.08)
/// on every edge, clamped to the image. Returns `None` for an empty or non-finite box.
pub fn crop_with_padding(image: &RgbImage, bbox: [f32; 4], pad: f32) -> Option<RgbImage> {
    let (x, y, width, height) = padded_box(image, bbox, pad)?;
    Some(image::imageops::crop_imm(image, x, y, width, height).to_image())
}

/// Padded crop rectangle as `(x, y, width, height)` in photo pixels.
fn padded_box(image: &RgbImage, bbox: [f32; 4], pad: f32) -> Option<(u32, u32, u32, u32)> {
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
    Some((x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// Grey used outside the mask so the embedder sees a neutral background.
pub const CUTOUT_BACKGROUND: image::Rgb<u8> = image::Rgb([128, 128, 128]);

/// Masked crop of `bbox` (photo pixels, `[x, y, w, h]`) padded like `crop_with_padding`.
///
/// `mask` may be lower resolution than the photo as long as it covers the whole frame with the
/// same aspect ratio; it is sampled nearest-neighbour over the crop region and thresholded at
/// 128. Pixels outside the mask become [`CUTOUT_BACKGROUND`]; the rest keep their colour.
pub fn cutout(image: &RgbImage, mask: &GrayImage, bbox: [f32; 4], pad: f32) -> Option<RgbImage> {
    if mask.width() == 0 || mask.height() == 0 {
        return None;
    }
    let (x, y, width, height) = padded_box(image, bbox, pad)?;
    let mut out = image::imageops::crop_imm(image, x, y, width, height).to_image();
    let scale_x = f64::from(mask.width()) / f64::from(image.width());
    let scale_y = f64::from(mask.height()) / f64::from(image.height());
    let last_x = mask.width() - 1;
    let last_y = mask.height() - 1;
    for (dx, dy, pixel) in out.enumerate_pixels_mut() {
        let mx = (f64::from(x + dx) * scale_x).floor() as u32;
        let my = (f64::from(y + dy) * scale_y).floor() as u32;
        if mask.get_pixel(mx.min(last_x), my.min(last_y))[0] < 128 {
            *pixel = CUTOUT_BACKGROUND;
        }
    }
    Some(out)
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

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        RgbImage::new(width, height)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn sniffs_only_jpeg_and_png() {
        assert_eq!(sniff_format(&png(2, 2)), Some(image::ImageFormat::Png));
        assert_eq!(
            sniff_format(b"\xff\xd8\xff\xe0rest"),
            Some(image::ImageFormat::Jpeg)
        );
        assert_eq!(sniff_format(b"RIFF\0\0\0\0WEBPVP8 "), None);
        assert_eq!(sniff_format(b"GIF89a"), None);
        assert_eq!(sniff_format(b""), None);
    }

    #[test]
    fn decode_limited_enforces_formats_and_dimensions() {
        assert!(decode_limited(&png(8, 8)).is_ok());
        assert!(decode_limited(b"RIFF\0\0\0\0WEBPVP8 ").is_err());
        assert!(decode_limited(b"not an image").is_err());
        assert!(decode_limited(&png(MAX_DECODE_SIDE + 1, 1)).is_err());
        assert!(decode_limited(&png(MAX_DECODE_SIDE, 1)).is_ok());
    }

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
    fn cutout_keeps_foreground_and_paints_background_grey() {
        let image = RgbImage::from_pixel(16, 16, image::Rgb([10, 20, 30]));
        let mut mask = image::GrayImage::new(16, 16);
        for (x, _y, pixel) in mask.enumerate_pixels_mut() {
            *pixel = image::Luma([if x < 8 { 128 } else { 127 }]);
        }
        let cut = cutout(&image, &mask, [0., 0., 16., 16.], 0.0).unwrap();
        assert_eq!(*cut.get_pixel(3, 3), image::Rgb([10, 20, 30]));
        assert_eq!(*cut.get_pixel(12, 12), CUTOUT_BACKGROUND);
    }

    #[test]
    fn cutout_matches_padded_crop_dimensions() {
        let image = RgbImage::new(100, 100);
        let mask = image::GrayImage::from_pixel(25, 25, image::Luma([255]));
        let bbox = [20., 20., 50., 50.];
        let cut = cutout(&image, &mask, bbox, 0.08).unwrap();
        let plain = crop_with_padding(&image, bbox, 0.08).unwrap();
        assert_eq!((cut.width(), cut.height()), (plain.width(), plain.height()));
    }

    #[test]
    fn cutout_upscales_low_resolution_mask() {
        let image = RgbImage::from_pixel(16, 16, image::Rgb([200, 100, 50]));
        let mut mask = image::GrayImage::new(4, 4);
        for (x, _y, pixel) in mask.enumerate_pixels_mut() {
            *pixel = image::Luma([if x < 2 { 255 } else { 0 }]);
        }
        let cut = cutout(&image, &mask, [0., 0., 16., 16.], 0.0).unwrap();
        assert_eq!(*cut.get_pixel(0, 0), image::Rgb([200, 100, 50]));
        assert_eq!(*cut.get_pixel(7, 15), image::Rgb([200, 100, 50]));
        assert_eq!(*cut.get_pixel(8, 0), CUTOUT_BACKGROUND);
        assert_eq!(*cut.get_pixel(15, 15), CUTOUT_BACKGROUND);
    }

    #[test]
    fn cutout_rejects_empty_or_out_of_bounds_boxes() {
        let image = RgbImage::new(10, 10);
        let mask = image::GrayImage::from_pixel(5, 5, image::Luma([255]));
        assert!(cutout(&image, &mask, [0., 0., 0., 5.], 0.08).is_none());
        assert!(cutout(&image, &mask, [f32::NAN, 0., 5., 5.], 0.08).is_none());
        assert!(cutout(&image, &mask, [50., 50., 5., 5.], 0.0).is_none());
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
