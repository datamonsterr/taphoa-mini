use image::{
    RgbImage,
    imageops::{self, FilterType},
};
use std::collections::BTreeSet;
use taphoa_recognition::crop::LETTERBOX_BACKGROUND;

fn random(seed: u64) -> u64 {
    let mut x = seed.wrapping_add(0x9e3779b97f4a7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

pub fn split_classes(classes: &[u32], seed: u64) -> BTreeSet<u32> {
    let mut classes = classes.to_vec();
    classes.sort_by_key(|x| (random(seed ^ u64::from(*x)), *x));
    let count = (classes.len() as f32 * 0.2).round() as usize;
    classes.into_iter().take(count).collect()
}

pub fn rotate(image: &RgbImage, angle: u32) -> RgbImage {
    let (w, h) = image.dimensions();
    let mut out = RgbImage::from_pixel(w, h, LETTERBOX_BACKGROUND);
    let radians = (angle as f32).to_radians();
    let (sin, cos) = radians.sin_cos();
    let (cx, cy) = ((w as f32 - 1.0) / 2.0, (h as f32 - 1.0) / 2.0);
    for (x, y, pixel) in out.enumerate_pixels_mut() {
        let (dx, dy) = (x as f32 - cx, y as f32 - cy);
        let sx = (cos * dx + sin * dy + cx).round() as i32;
        let sy = (-sin * dx + cos * dy + cy).round() as i32;
        if sx >= 0 && sy >= 0 && sx < w as i32 && sy < h as i32 {
            *pixel = *image.get_pixel(sx as u32, sy as u32);
        }
    }
    out
}

pub fn paste(
    image: &RgbImage,
    background: &RgbImage,
    fraction: f32,
    xseed: u64,
    yseed: u64,
) -> (RgbImage, [f32; 4]) {
    let mut out = imageops::resize(background, 1024, 1024, FilterType::CatmullRom);
    let longest = (1024.0 * fraction).round() as u32;
    let scale = longest as f32 / image.width().max(image.height()) as f32;
    let width = (image.width() as f32 * scale).round().max(1.0) as u32;
    let height = (image.height() as f32 * scale).round().max(1.0) as u32;
    let resized = imageops::resize(image, width, height, FilterType::CatmullRom);
    let x = (random(xseed) % u64::from(1025 - width)) as u32;
    let y = (random(yseed) % u64::from(1025 - height)) as u32;
    imageops::replace(&mut out, &resized, i64::from(x), i64::from(y));
    (out, [x as f32, y as f32, width as f32, height as f32])
}

pub fn erase(image: &RgbImage, fraction: f32, seed: u64) -> RgbImage {
    let mut out = image.clone();
    let width = (image.width() as f32 * fraction.sqrt()).round().max(1.0) as u32;
    let height = (image.height() as f32 * fraction.sqrt()).round().max(1.0) as u32;
    let x = (random(seed) % u64::from(image.width() - width + 1)) as u32;
    let y = (random(seed ^ 0x12345678) % u64::from(image.height() - height + 1)) as u32;
    for py in y..y + height {
        for px in x..x + width {
            out.put_pixel(px, py, LETTERBOX_BACKGROUND);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn rotations_keep_canvas_size() {
        let image = RgbImage::from_pixel(31, 23, Rgb([1, 2, 3]));
        for angle in [0, 45, 90, 180] {
            assert_eq!(rotate(&image, angle).dimensions(), image.dimensions());
        }
    }

    #[test]
    fn paste_box_matches_scaled_object() {
        let image = RgbImage::new(400, 200);
        let background = RgbImage::new(1024, 1024);
        let (_, bounds) = paste(&image, &background, 0.30, 12, 45);
        assert_eq!(bounds[2], 307.0);
        assert_eq!(bounds[3], 154.0);
        assert!(bounds[0] + bounds[2] <= 1024.0);
        assert!(bounds[1] + bounds[3] <= 1024.0);
    }

    #[test]
    fn rectangle_erases_requested_fraction() {
        let image = RgbImage::from_pixel(100, 100, Rgb([1, 2, 3]));
        for fraction in [0.3, 0.5] {
            let erased = erase(&image, fraction, 41);
            let changed = erased.pixels().filter(|p| **p != Rgb([1, 2, 3])).count();
            assert!((changed as f32 / 10000.0 - fraction).abs() < 0.02);
        }
    }

    #[test]
    fn class_split_is_deterministic() {
        let a = split_classes(&(0..81).collect::<Vec<_>>(), 42);
        let b = split_classes(&(0..81).collect::<Vec<_>>(), 42);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert_ne!(a, split_classes(&(0..81).collect::<Vec<_>>(), 43));
    }
}
