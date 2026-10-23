use crate::{Segment, SegmentError, Segmenter, filter_and_nms};
use image::{DynamicImage, ImageReader, imageops::FilterType};
use ort::{session::Session, value::Tensor};
use std::{io::Cursor, path::Path, sync::Mutex};

const SIDE: usize = 1024;
const MEAN: [f32; 3] = [123.675, 116.28, 103.53];
const STD: [f32; 3] = [58.395, 57.12, 57.375];

#[derive(Clone, Debug)]
pub struct SamOptions {
    pub points_per_side: u32,
    pub min_score: f32,
    pub min_area: u32,
    pub max_area_ratio: f32,
    pub nms_iou: f32,
}
impl Default for SamOptions {
    fn default() -> Self {
        Self {
            points_per_side: 8,
            min_score: 0.88,
            min_area: 64,
            max_area_ratio: 0.95,
            nms_iou: 0.7,
        }
    }
}

struct Sessions {
    encoder: Session,
    decoder: Session,
}
pub struct SamSegmenter {
    sessions: Mutex<Sessions>,
    options: SamOptions,
}

fn inference(error: impl std::fmt::Display) -> SegmentError {
    SegmentError::Inference(error.to_string())
}

impl SamSegmenter {
    pub fn load(encoder: &Path, decoder: &Path, options: SamOptions) -> Result<Self, SegmentError> {
        if options.points_per_side == 0
            || options.points_per_side > 32
            || !options.min_score.is_finite()
            || !(0.0..=1.0).contains(&options.min_score)
            || !(0.0..=1.0).contains(&options.max_area_ratio)
            || !(0.0..=1.0).contains(&options.nms_iou)
        {
            return Err(inference("invalid SAM filtering/grid options"));
        }
        // Explicit loading reports a missing runtime as an error, before any tensor API is called.
        let library =
            std::env::var("ORT_DYLIB_PATH").unwrap_or_else(|_| "libonnxruntime.so".into());
        let environment = ort::init_from(library)
            .map_err(inference)?
            .build()
            .map_err(inference)?;
        let encoder = Session::builder(&environment)
            .map_err(inference)?
            .with_intra_threads(2)
            .map_err(inference)?
            .commit_from_file(encoder)
            .map_err(inference)?;
        let decoder = Session::builder(&environment)
            .map_err(inference)?
            .with_intra_threads(2)
            .map_err(inference)?
            .commit_from_file(decoder)
            .map_err(inference)?;
        Ok(Self {
            sessions: Mutex::new(Sessions { encoder, decoder }),
            options,
        })
    }
}

/// SAM ResizeLongestSide rounds each dimension independently. Padding is bottom/right,
/// after RGB normalization, so padded values are zero in the normalized space.
fn resized_dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = SIDE as f64 / f64::from(width.max(height));
    (
        (f64::from(width) * scale + 0.5) as u32,
        (f64::from(height) * scale + 0.5) as u32,
    )
}

fn preprocess(image: &DynamicImage) -> (Vec<f32>, u32, u32) {
    let (width, height) = resized_dimensions(image.width(), image.height());
    let resized = image
        .resize_exact(width, height, FilterType::Triangle)
        .to_rgb8();
    let mut tensor = vec![0.0; 3 * SIDE * SIDE];
    for (x, y, pixel) in resized.enumerate_pixels() {
        for channel in 0..3 {
            tensor[channel * SIDE * SIDE + y as usize * SIDE + x as usize] =
                (f32::from(pixel[channel]) - MEAN[channel]) / STD[channel];
        }
    }
    (tensor, width, height)
}

/// Decoder exports return logits already resized/cropped to orig_im_size.
fn mask_segment(mask: &[f32], width: u32, height: u32, score: f32) -> Option<Segment> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, 0, 0);
    let mut area = 0;
    for (index, value) in mask.iter().enumerate() {
        if *value > 0.0 {
            let x = index as u32 % width;
            let y = index as u32 / width;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            area += 1;
        }
    }
    (area > 0).then(|| Segment {
        bbox: [
            min_x as f32,
            min_y as f32,
            (max_x - min_x + 1) as f32,
            (max_y - min_y + 1) as f32,
        ],
        score,
        area,
    })
}

impl Segmenter for SamSegmenter {
    fn segment(&self, bytes: &[u8]) -> Result<Vec<Segment>, SegmentError> {
        // Bound decompression as well as compressed upload size. JPEG and PNG only.
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| SegmentError::InvalidImage(e.to_string()))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|e| SegmentError::InvalidImage(e.to_string()))?;
        let (width, height) = (image.width(), image.height());
        let (input, resized_width, resized_height) = preprocess(&image);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| inference("SAM session lock poisoned"))?;
        let Sessions { encoder, decoder } = &mut *sessions;
        let encoded = encoder
            .run(ort::inputs![
                Tensor::from_array(([1, 3, SIDE, SIDE], input)).map_err(inference)?
            ])
            .map_err(inference)?;
        let (embedding_shape, embeddings) =
            encoded[0].try_extract_tensor::<f32>().map_err(inference)?;
        let mut candidates = Vec::new();
        for row in 0..self.options.points_per_side {
            for column in 0..self.options.points_per_side {
                let x = (column as f32 + 0.5) * resized_width as f32
                    / self.options.points_per_side as f32;
                let y = (row as f32 + 0.5) * resized_height as f32
                    / self.options.points_per_side as f32;
                // A foreground point plus SAM's required "not a point" padding label.
                let output = decoder.run(ort::inputs![
                    "image_embeddings" => Tensor::from_array((embedding_shape.to_vec(), embeddings.to_vec())).map_err(inference)?,
                    "point_coords" => Tensor::from_array(([1,2,2], vec![x,y,0.,0.])).map_err(inference)?,
                    "point_labels" => Tensor::from_array(([1,2], vec![1_f32,-1.])).map_err(inference)?,
                    "mask_input" => Tensor::from_array(([1,1,256,256], vec![0_f32;256*256])).map_err(inference)?,
                    "has_mask_input" => Tensor::from_array(([1], vec![0_f32])).map_err(inference)?,
                    "orig_im_size" => Tensor::from_array(([2], vec![height as f32,width as f32])).map_err(inference)?
                ]).map_err(inference)?;
                let (shape, masks) = output["masks"]
                    .try_extract_tensor::<f32>()
                    .map_err(inference)?;
                let (_, scores) = output["iou_predictions"]
                    .try_extract_tensor::<f32>()
                    .map_err(inference)?;
                let pixels = width as usize * height as usize;
                if shape.len() != 4
                    || shape[0] != 1
                    || shape[2] != i64::from(height)
                    || shape[3] != i64::from(width)
                    || masks.len() != scores.len() * pixels
                {
                    return Err(inference(
                        "decoder must return [1,N,original_height,original_width] masks",
                    ));
                }
                for (mask, score) in masks.chunks_exact(pixels).zip(scores) {
                    if *score >= self.options.min_score
                        && let Some(segment) = mask_segment(mask, width, height, *score)
                    {
                        candidates.push(segment);
                    }
                }
            }
        }
        Ok(filter_and_nms(
            candidates,
            &self.options,
            u64::from(width) * u64::from(height),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn longest_side_rounding_and_normalized_padding() {
        assert_eq!(resized_dimensions(640, 480), (1024, 768));
        assert_eq!(resized_dimensions(333, 1000), (341, 1024));
        let image =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 2, image::Rgb([255, 0, 128])));
        let (input, width, height) = preprocess(&image);
        assert_eq!((width, height), (1024, 512));
        assert!((input[0] - (255.0 - MEAN[0]) / STD[0]).abs() < 1e-6);
        assert!((input[SIDE * SIDE] - (0.0 - MEAN[1]) / STD[1]).abs() < 1e-6);
        assert!((input[2 * SIDE * SIDE] - (128.0 - MEAN[2]) / STD[2]).abs() < 1e-6);
        assert_eq!(input[512 * SIDE], 0.0);
        assert_eq!(input[3 * SIDE * SIDE - 1], 0.0);
    }
    #[test]
    fn masks_use_original_pixel_coordinates_and_inclusive_extent() {
        let segment = mask_segment(&[-1., 1., 1., -1., 1., -1.], 3, 2, 0.9).unwrap();
        assert_eq!(segment.bbox, [1., 0., 2., 2.]);
        assert_eq!(segment.area, 3);
        assert!(mask_segment(&[-1.; 6], 3, 2, 0.9).is_none());
    }
}
