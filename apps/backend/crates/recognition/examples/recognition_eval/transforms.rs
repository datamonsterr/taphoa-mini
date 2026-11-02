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
