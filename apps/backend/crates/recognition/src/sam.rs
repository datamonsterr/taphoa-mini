use crate::{Segment, SegmentError, Segmenter, filter_and_nms};
use image::{DynamicImage, GrayImage, imageops::FilterType};
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::{Tensor, TensorRef},
};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

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
    /// Intra-op threads for the encoder; 0 = all cores.
    pub threads: usize,
    /// Number of single-threaded decoder sessions; 0 = `min(threads, 8)`.
    pub decoders: usize,
    /// Longest side of the masks the decoder produces; boxes are scaled back to the photo.
    pub mask_side: u32,
}
impl Default for SamOptions {
    fn default() -> Self {
        Self {
            points_per_side: 8,
            min_score: 0.88,
            min_area: 64,
            max_area_ratio: 0.95,
            nms_iou: 0.7,
            threads: 0,
            decoders: 0,
            mask_side: 256,
        }
    }
}

impl SamOptions {
    /// Defaults overridden by `SAM_THREADS`, `SAM_DECODERS`, `SAM_POINTS_PER_SIDE`,
    /// `SAM_MASK_SIDE`.
    pub fn from_env() -> Self {
        fn var<T: std::str::FromStr>(name: &str) -> Option<T> {
            std::env::var(name).ok()?.parse().ok()
        }
        let mut options = Self::default();
        options.threads = var("SAM_THREADS").unwrap_or(options.threads);
        options.decoders = var("SAM_DECODERS").unwrap_or(options.decoders);
        options.points_per_side = var("SAM_POINTS_PER_SIDE").unwrap_or(options.points_per_side);
        options.mask_side = var("SAM_MASK_SIDE").unwrap_or(options.mask_side);
        options
    }
}

struct Sessions {
    encoder: Mutex<Session>,
    /// One single-threaded decoder session per worker; prompts are split across them.
    decoders: Vec<Mutex<Session>>,
    /// HWC raw RGB input (MobileSAM-style export that normalizes and pads internally).
    hwc_input: bool,
}

/// Encoder output for one photo. Cheap to clone via Arc; cached per image_id by the API.
pub struct ImageEncoding {
    pub width: u32,
    pub height: u32,
    /// Resized dimensions passed into the encoder (in the 1024-space).
    pub(crate) resized_width: u32,
    pub(crate) resized_height: u32,
    pub(crate) embedding_shape: Vec<i64>,
    pub(crate) embeddings: Vec<f32>,
    /// Longest side of output mask in pixels.
    pub(crate) mask_side: u32,
}

/// Result of a point-prompted decode: the best segment plus the low-res mask.
pub struct PointSegment {
    /// Bounding box / area in ORIGINAL photo pixels.
    pub segment: Segment,
    /// Low-resolution binary mask (0 or 255) covering the whole photo with aspect preserved.
    /// Longest side == mask_side (default 256). E.g. 256x192 for a 1600x1200 photo.
    pub mask: GrayImage,
}

impl ImageEncoding {
    /// Minimal stub for tests and mocks; returns a plausible 1600×1200 encoding with zero
    /// embeddings. Not a cfg(test) item so that `MockPointSegmenter::encode` can use it in
    /// integration-test crates that import the mock.
    pub(crate) fn mock() -> Self {
        Self {
            width: 1600,
            height: 1200,
            resized_width: 1024,
            resized_height: 768,
            embedding_shape: vec![1, 256, 64, 64],
            embeddings: vec![0.0; 256 * 64 * 64],
            mask_side: 256,
        }
    }
}

/// Point-prompted segmentation trait. Implementations must be Send + Sync.
pub trait PointSegmenter: Send + Sync {
    /// Runs the encoder on raw image bytes; the result can be cloned and cached.
    fn encode(&self, image: &[u8]) -> Result<Arc<ImageEncoding>, SegmentError>;
    /// Runs the decoder once for the given points against an already-computed encoding.
    fn decode_points(
        &self,
        encoding: &ImageEncoding,
        points: &[crate::PointPrompt],
    ) -> Result<PointSegment, SegmentError>;
}

pub struct SamSegmenter {
    sessions: Sessions,
    options: SamOptions,
    /// Round-robin counter for the point-decode decoder pool.
    /// Each `decode_points` call increments this and tries the selected session first,
    /// spreading concurrent single-prompt requests across all sessions rather than
    /// serialising them all on decoders[0] while the rest of the pool sits idle.
    decode_rr: AtomicUsize,
}

fn inference(error: impl std::fmt::Display) -> SegmentError {
    SegmentError::Inference(error.to_string())
}

fn thread_count(requested: usize) -> usize {
    if requested > 0 {
        requested
    } else {
        std::thread::available_parallelism().map_or(2, |n| n.get())
    }
}

/// Decoder sessions to run: `decoders` when set, else one per thread capped at 8.
fn decoder_pool(decoders: usize, threads: usize) -> usize {
    if decoders > 0 {
        decoders
    } else {
        threads.min(8)
    }
    .max(1)
}

impl SamSegmenter {
    pub fn load(encoder: &Path, decoder: &Path, options: SamOptions) -> Result<Self, SegmentError> {
        if options.points_per_side == 0
            || options.points_per_side > 32
            || !options.min_score.is_finite()
            || !(0.0..=1.0).contains(&options.min_score)
            || !(0.0..=1.0).contains(&options.max_area_ratio)
            || !(0.0..=1.0).contains(&options.nms_iou)
            || !(32..=1024).contains(&options.mask_side)
        {
            return Err(inference("invalid SAM filtering/grid options"));
        }
        let environment = crate::ort_environment().map_err(inference)?;
        let threads = thread_count(options.threads);
        let decoder_count = decoder_pool(options.decoders, threads);
        let spinning = crate::ort_spinning();
        let encoder = Session::builder(&environment)
            .map_err(inference)?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(inference)?
            .with_intra_threads(threads)
            .map_err(inference)?
            .with_intra_op_spinning(spinning)
            .map_err(inference)?
            .with_inter_op_spinning(spinning)
            .map_err(inference)?
            .commit_from_file(encoder)
            .map_err(inference)?;
        let hwc_input = encoder
            .inputs()
            .first()
            .and_then(|input| input.dtype().tensor_shape())
            .is_some_and(|shape| shape.len() == 3);
        let mut decoders = Vec::new();
        for _ in 0..decoder_count {
            decoders.push(Mutex::new(
                Session::builder(&environment)
                    .map_err(inference)?
                    .with_optimization_level(GraphOptimizationLevel::All)
                    .map_err(inference)?
                    .with_intra_threads(1)
                    .map_err(inference)?
                    .with_intra_op_spinning(spinning)
                    .map_err(inference)?
                    .with_inter_op_spinning(spinning)
                    .map_err(inference)?
                    .commit_from_file(decoder)
                    .map_err(inference)?,
            ));
        }
        let this = Self {
            sessions: Sessions {
                encoder: Mutex::new(encoder),
                decoders,
                hwc_input,
            },
            options,
            decode_rr: AtomicUsize::new(0),
        };
        this.warm_up()?;
        Ok(this)
    }

    /// First inference allocates arenas and packs weights; pay for it at boot, not on a request.
    fn warm_up(&self) -> Result<(), SegmentError> {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            320,
            240,
            image::Rgb([128, 128, 128]),
        ));
        self.segment_image(&image).map(|_| ())
    }

    /// Decodes `points` across the decoder workers; returns accepted masks with their bitmaps.
    fn run_round(
        &self,
        points: &[(f32, f32)],
        embedding_shape: &[i64],
        embeddings: &[f32],
        dims: (u32, u32),
    ) -> Result<Vec<Found>, SegmentError> {
        if points.is_empty() {
            return Ok(Vec::new());
        }
        let workers = self.sessions.decoders.len().max(1);
        let chunk = points.len().div_ceil(workers);
        let options = &self.options;
        let results: Vec<Result<Vec<Found>, SegmentError>> = std::thread::scope(|scope| {
            let handles: Vec<_> = points
                .chunks(chunk)
                .zip(&self.sessions.decoders)
                .map(|(points, decoder)| {
                    scope.spawn(move || {
                        let mut decoder = decoder
                            .lock()
                            .map_err(|_| inference("SAM session lock poisoned"))?;
                        decode_points_auto(
                            &mut decoder,
                            embedding_shape,
                            embeddings,
                            points,
                            dims,
                            options,
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| {
                    h.join()
                        .unwrap_or_else(|_| Err(inference("decoder worker panicked")))
                })
                .collect()
        });
        let mut all = Vec::new();
        for result in results {
            all.extend(result?);
        }
        Ok(all)
    }

    fn segment_image(
        &self,
        image: &DynamicImage,
    ) -> Result<(Vec<Segment>, SegmentTimings), SegmentError> {
        let t0 = std::time::Instant::now();
        let (width, height) = (image.width(), image.height());
        let rgb = image.to_rgb8();
        let (resized_width, resized_height) = resized_dimensions(width, height);
        let resized =
            image::imageops::resize(&rgb, resized_width, resized_height, FilterType::Triangle);
        let input = if self.sessions.hwc_input {
            let data: Vec<f32> = resized.as_raw().iter().map(|v| f32::from(*v)).collect();
            Tensor::from_array(([resized_height as usize, resized_width as usize, 3], data))
                .map_err(inference)?
        } else {
            Tensor::from_array(([1, 3, SIDE, SIDE], preprocess_rgb(&resized))).map_err(inference)?
        };
        let preprocess_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = std::time::Instant::now();
        let mut encoder = self
            .sessions
            .encoder
            .lock()
            .map_err(|_| inference("SAM session lock poisoned"))?;
        let encoded = encoder.run(ort::inputs![input]).map_err(inference)?;
        let encode_ms = t1.elapsed().as_secs_f64() * 1000.0;
        let t2 = std::time::Instant::now();
        let (embedding_shape, embeddings) =
            encoded[0].try_extract_tensor::<f32>().map_err(inference)?;
        let embedding_shape = embedding_shape.to_vec();

        // Decode at reduced resolution: mask upsampling dominates decoder time at 1600 px.
        let scale = (f64::from(self.options.mask_side) / f64::from(width.max(height))).min(1.0);
        let mask_width = ((f64::from(width) * scale).round() as u32).max(1);
        let mask_height = ((f64::from(height) * scale).round() as u32).max(1);
        let grid = self.options.points_per_side;
        let grid_points = |side: u32| -> Vec<(f32, f32)> {
            (0..side)
                .flat_map(|row| (0..side).map(move |column| (row, column)))
                .map(|(row, column)| {
                    (
                        (column as f32 + 0.5) * resized_width as f32 / side as f32,
                        (row as f32 + 0.5) * resized_height as f32 / side as f32,
                    )
                })
                .collect()
        };
        let dims = (mask_width, mask_height);
        let embedding_shape = &embedding_shape;
        // Round 1: a coarse grid. Round 2: only fine-grid points that no accepted mask covers yet.
        // Each decode costs ~150 ms of one core, so skipping covered points is the main saving.
        let coarse = (grid / 2).max(1);
        let mut found = self.run_round(&grid_points(coarse), embedding_shape, embeddings, dims)?;
        if grid > coarse {
            let remaining: Vec<(f32, f32)> = grid_points(grid)
                .into_iter()
                .filter(|&(x, y)| {
                    let mx = ((x * mask_width as f32 / resized_width as f32) as usize)
                        .min(mask_width as usize - 1);
                    let my = ((y * mask_height as f32 / resized_height as f32) as usize)
                        .min(mask_height as usize - 1);
                    !found
                        .iter()
                        .any(|(_, mask)| mask[my * mask_width as usize + mx])
                })
                .collect();
            found.extend(self.run_round(&remaining, embedding_shape, embeddings, dims)?);
        }
        let mut candidates: Vec<Segment> = found.into_iter().map(|(s, _)| s).collect();
        // Scale boxes and areas from mask resolution back to the original photo.
        let sx = f64::from(width) / f64::from(mask_width);
        let sy = f64::from(height) / f64::from(mask_height);
        for c in &mut candidates {
            let x0 = (f64::from(c.bbox[0]) * sx).floor();
            let y0 = (f64::from(c.bbox[1]) * sy).floor();
            let x1 = (f64::from(c.bbox[0] + c.bbox[2]) * sx)
                .ceil()
                .min(f64::from(width));
            let y1 = (f64::from(c.bbox[1] + c.bbox[3]) * sy)
                .ceil()
                .min(f64::from(height));
            c.bbox = [x0 as f32, y0 as f32, (x1 - x0) as f32, (y1 - y0) as f32];
            c.area = (f64::from(c.area) * sx * sy).round() as u32;
        }
        let prompts_ms = t2.elapsed().as_secs_f64() * 1000.0;
        let segments = filter_and_nms(
            candidates,
            &self.options,
            u64::from(width) * u64::from(height),
        );
        Ok((
            segments,
            SegmentTimings {
                decode_ms: 0.0,
                preprocess_ms,
                encode_ms,
                prompts_ms,
            },
        ))
    }

    /// Like `segment`, also returning per-stage timings for scan diagnostics.
    pub fn segment_with_timings(
        &self,
        bytes: &[u8],
    ) -> Result<(Vec<Segment>, SegmentTimings), SegmentError> {
        let t = std::time::Instant::now();
        let image = decode(bytes)?;
        let decode_ms = t.elapsed().as_secs_f64() * 1000.0;
        let (segments, mut timings) = self.segment_image(&image)?;
        timings.decode_ms = decode_ms;
        Ok((segments, timings))
    }

    /// Run the encoder on a decoded image and return an `ImageEncoding`.
    fn encode_image(&self, image: &DynamicImage) -> Result<ImageEncoding, SegmentError> {
        let (width, height) = (image.width(), image.height());
        let rgb = image.to_rgb8();
        let (resized_width, resized_height) = resized_dimensions(width, height);
        let resized =
            image::imageops::resize(&rgb, resized_width, resized_height, FilterType::Triangle);
        let input = if self.sessions.hwc_input {
            let data: Vec<f32> = resized.as_raw().iter().map(|v| f32::from(*v)).collect();
            Tensor::from_array(([resized_height as usize, resized_width as usize, 3], data))
                .map_err(inference)?
        } else {
            Tensor::from_array(([1, 3, SIDE, SIDE], preprocess_rgb(&resized))).map_err(inference)?
        };
        let mut encoder = self
            .sessions
            .encoder
            .lock()
            .map_err(|_| inference("SAM encoder lock poisoned"))?;
        let encoded = encoder.run(ort::inputs![input]).map_err(inference)?;
        let (embedding_shape, embeddings_view) =
            encoded[0].try_extract_tensor::<f32>().map_err(inference)?;
        let embedding_shape = embedding_shape.to_vec();
        let embeddings = embeddings_view.to_vec();

        Ok(ImageEncoding {
            width,
            height,
            resized_width,
            resized_height,
            embedding_shape,
            embeddings,
            mask_side: self.options.mask_side,
        })
    }
}

impl PointSegmenter for SamSegmenter {
    fn encode(&self, image: &[u8]) -> Result<Arc<ImageEncoding>, SegmentError> {
        let img = decode(image)?;
        let enc = self.encode_image(&img)?;
        Ok(Arc::new(enc))
    }

    fn decode_points(
        &self,
        encoding: &ImageEncoding,
        points: &[crate::PointPrompt],
    ) -> Result<PointSegment, SegmentError> {
        let (width, height) = (encoding.width, encoding.height);
        let mask_side = encoding.mask_side;

        // Compute mask dimensions (aspect-preserving, longest side = mask_side).
        let scale = (f64::from(mask_side) / f64::from(width.max(height))).min(1.0);
        let mask_width = ((f64::from(width) * scale).round() as u32).max(1);
        let mask_height = ((f64::from(height) * scale).round() as u32).max(1);

        // Transform photo pixel coords to the 1024-resized space.
        // resized_dimensions() gives the same scale as preprocess uses.
        let rx = encoding.resized_width as f32 / width as f32;
        let ry = encoding.resized_height as f32 / height as f32;

        // Build the decoder point_coords and point_labels tensors.
        // SAM ONNX decoder expects:
        //   coords: [1, N+1, 2]  (N user points + 1 padding point)
        //   labels: [1, N+1]     (user labels + -1 for padding)
        let n = points.len();
        let mut coords = Vec::with_capacity((n + 1) * 2);
        let mut labels = Vec::with_capacity(n + 1);
        for p in points {
            coords.push(p.x * rx);
            coords.push(p.y * ry);
            labels.push(p.label as f32);
        }
        // SAM ONNX box/padding sentinel (label = -1).
        coords.push(0.0_f32);
        coords.push(0.0_f32);
        labels.push(-1.0_f32);

        let mask_input = vec![0_f32; 256 * 256];

        // Pick a decoder session from the pool using round-robin + try_lock fallback.
        // Rationale: concurrent point requests from the API would otherwise all block on
        // decoders[0] while the remaining sessions sit idle; try_lock lets us spread load
        // across the whole pool and only fall back to a blocking lock on the RR slot when
        // every session happens to be busy at the same instant.
        let n_dec = self.sessions.decoders.len();
        let start = self.decode_rr.fetch_add(1, Ordering::Relaxed) % n_dec;
        let mut decoder = {
            // Try each session from `start`, wrapping around; lock the RR slot if all busy.
            let picked = (0..n_dec)
                .map(|i| &self.sessions.decoders[(start + i) % n_dec])
                .find_map(|m| m.try_lock().ok());
            match picked {
                Some(guard) => guard,
                None => self.sessions.decoders[start]
                    .lock()
                    .map_err(|_| inference("SAM decoder lock poisoned"))?,
            }
        };

        let output = decoder
            .run(ort::inputs![
                "image_embeddings" => TensorRef::from_array_view(
                    (encoding.embedding_shape.to_vec(), encoding.embeddings.as_slice())
                ).map_err(inference)?,
                "point_coords" => Tensor::from_array(([1, n + 1, 2], coords)).map_err(inference)?,
                "point_labels" => Tensor::from_array(([1, n + 1], labels)).map_err(inference)?,
                "mask_input" => TensorRef::from_array_view(
                    ([1, 1, 256, 256], mask_input.as_slice())
                ).map_err(inference)?,
                "has_mask_input" => Tensor::from_array(([1], vec![0_f32])).map_err(inference)?,
                "orig_im_size" => Tensor::from_array(
                    ([2], vec![mask_height as f32, mask_width as f32])
                ).map_err(inference)?
            ])
            .map_err(inference)?;

        let (shape, masks) = output["masks"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let (_, scores) = output["iou_predictions"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;

        let pixels = mask_width as usize * mask_height as usize;
        if shape.len() != 4
            || shape[0] != 1
            || shape[2] != i64::from(mask_height)
            || shape[3] != i64::from(mask_width)
            || masks.len() != scores.len() * pixels
        {
            return Err(inference(
                "decoder must return [1,N,orig_height,orig_width] masks",
            ));
        }

        // Pick the best mask by score.
        let best = masks
            .chunks_exact(pixels)
            .zip(scores.iter())
            .max_by(|(_, a), (_, b)| a.total_cmp(b))
            .ok_or_else(|| inference("decoder returned no masks"))?;
        let (best_mask_logits, &best_score) = best;

        // Threshold at 0 to get foreground pixels.
        let fg: Vec<bool> = best_mask_logits.iter().map(|&v| v > 0.0).collect();

        // Build the GrayImage (0 or 255).
        let gray_pixels: Vec<u8> = fg.iter().map(|&b| if b { 255 } else { 0 }).collect();
        let gray_img = GrayImage::from_raw(mask_width, mask_height, gray_pixels)
            .ok_or_else(|| inference("failed to build gray mask image"))?;

        // Compute bbox in mask space, then scale back to photo pixels.
        let segment_in_mask = mask_segment(best_mask_logits, mask_width, mask_height, best_score)
            .ok_or_else(|| inference("mask is empty — no foreground pixels"))?;

        // Scale from mask resolution back to original photo pixels.
        let sx = f64::from(width) / f64::from(mask_width);
        let sy = f64::from(height) / f64::from(mask_height);
        let x0 = (f64::from(segment_in_mask.bbox[0]) * sx).floor();
        let y0 = (f64::from(segment_in_mask.bbox[1]) * sy).floor();
        let x1 = (f64::from(segment_in_mask.bbox[0] + segment_in_mask.bbox[2]) * sx)
            .ceil()
            .min(f64::from(width));
        let y1 = (f64::from(segment_in_mask.bbox[1] + segment_in_mask.bbox[3]) * sy)
            .ceil()
            .min(f64::from(height));
        let photo_area = (f64::from(segment_in_mask.area) * sx * sy).round() as u32;
        let segment = Segment {
            bbox: [x0 as f32, y0 as f32, (x1 - x0) as f32, (y1 - y0) as f32],
            score: best_score,
            area: photo_area,
        };

        Ok(PointSegment {
            segment,
            mask: gray_img,
        })
    }
}

/// Stage timings of one segmentation, in milliseconds.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SegmentTimings {
    pub decode_ms: f64,
    pub preprocess_ms: f64,
    pub encode_ms: f64,
    pub prompts_ms: f64,
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, SegmentError> {
    // Bound decompression as well as compressed upload size. JPEG and PNG only.
    crate::crop::decode_limited(bytes).map_err(SegmentError::InvalidImage)
}

/// An accepted segment (mask resolution) with its foreground bitmap, used for coverage tests.
type Found = (Segment, Vec<bool>);

/// Decode automatic-mode grid points (each is a single-point foreground prompt).
fn decode_points_auto(
    decoder: &mut Session,
    embedding_shape: &[i64],
    embeddings: &[f32],
    points: &[(f32, f32)],
    (mask_width, mask_height): (u32, u32),
    options: &SamOptions,
) -> Result<Vec<Found>, SegmentError> {
    let mut out = Vec::new();
    let mask_input = vec![0_f32; 256 * 256];
    let pixels = mask_width as usize * mask_height as usize;
    for &(x, y) in points {
        // A foreground point plus SAM's required "not a point" padding label.
        let output = decoder
            .run(ort::inputs![
                "image_embeddings" => TensorRef::from_array_view((embedding_shape.to_vec(), embeddings)).map_err(inference)?,
                "point_coords" => Tensor::from_array(([1, 2, 2], vec![x, y, 0., 0.])).map_err(inference)?,
                "point_labels" => Tensor::from_array(([1, 2], vec![1_f32, -1.])).map_err(inference)?,
                "mask_input" => TensorRef::from_array_view(([1, 1, 256, 256], mask_input.as_slice())).map_err(inference)?,
                "has_mask_input" => Tensor::from_array(([1], vec![0_f32])).map_err(inference)?,
                "orig_im_size" => Tensor::from_array(([2], vec![mask_height as f32, mask_width as f32])).map_err(inference)?
            ])
            .map_err(inference)?;
        let (shape, masks) = output["masks"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let (_, scores) = output["iou_predictions"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        if shape.len() != 4
            || shape[0] != 1
            || shape[2] != i64::from(mask_height)
            || shape[3] != i64::from(mask_width)
            || masks.len() != scores.len() * pixels
        {
            return Err(inference(
                "decoder must return [1,N,orig_height,orig_width] masks",
            ));
        }
        for (mask, score) in masks.chunks_exact(pixels).zip(scores) {
            if *score >= options.min_score
                && let Some(segment) = mask_segment(mask, mask_width, mask_height, *score)
            {
                // Whole-scene masks must not count as "covering" every remaining point.
                if f64::from(segment.area) <= pixels as f64 * f64::from(options.max_area_ratio) {
                    out.push((segment, mask.iter().map(|v| *v > 0.0).collect()));
                }
            }
        }
    }
    Ok(out)
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

#[cfg(test)]
fn preprocess(image: &DynamicImage) -> (Vec<f32>, u32, u32) {
    let (width, height) = resized_dimensions(image.width(), image.height());
    let resized = image
        .resize_exact(width, height, FilterType::Triangle)
        .to_rgb8();
    (preprocess_rgb(&resized), width, height)
}

fn preprocess_rgb(resized: &image::RgbImage) -> Vec<f32> {
    let mut tensor = vec![0.0; 3 * SIDE * SIDE];
    for (x, y, pixel) in resized.enumerate_pixels() {
        for channel in 0..3 {
            tensor[channel * SIDE * SIDE + y as usize * SIDE + x as usize] =
                (f32::from(pixel[channel]) - MEAN[channel]) / STD[channel];
        }
    }
    tensor
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
        self.segment_with_timings(bytes)
            .map(|(segments, _)| segments)
    }
}

// ---- MockPointSegmenter ----

/// Deterministic test double for `PointSegmenter`.
///
/// Returns a configurable fixed `PointSegment`; counts `encode` calls so API tests can
/// assert that the cache is working (second call to decode_points on the same encoding
/// should not trigger another encode).
pub struct MockPointSegmenter {
    segment: Segment,
    mask_width: u32,
    mask_height: u32,
    encode_count: AtomicUsize,
}

impl MockPointSegmenter {
    /// Creates a mock that returns a segment with the given bbox/score/area for every prompt.
    /// The mask is a `mask_width × mask_height` fully-foreground image.
    pub fn new(segment: Segment, mask_width: u32, mask_height: u32) -> Self {
        Self {
            segment,
            mask_width,
            mask_height,
            encode_count: AtomicUsize::new(0),
        }
    }

    /// Number of times `encode` has been called.
    pub fn encode_calls(&self) -> usize {
        self.encode_count.load(Ordering::Relaxed)
    }
}

impl Default for MockPointSegmenter {
    fn default() -> Self {
        Self::new(
            Segment {
                bbox: [0., 0., 100., 100.],
                score: 0.99,
                area: 10000,
            },
            256,
            192,
        )
    }
}

impl PointSegmenter for MockPointSegmenter {
    fn encode(&self, _image: &[u8]) -> Result<Arc<ImageEncoding>, SegmentError> {
        self.encode_count.fetch_add(1, Ordering::Relaxed);
        Ok(Arc::new(ImageEncoding::mock()))
    }

    fn decode_points(
        &self,
        _encoding: &ImageEncoding,
        _points: &[crate::PointPrompt],
    ) -> Result<PointSegment, SegmentError> {
        let pixels = self.mask_width as usize * self.mask_height as usize;
        let gray_pixels = vec![255u8; pixels];
        let mask = GrayImage::from_raw(self.mask_width, self.mask_height, gray_pixels)
            .expect("valid mask dimensions");
        Ok(PointSegment {
            segment: self.segment.clone(),
            mask,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PointPrompt;

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

    #[test]
    fn decoder_pool_resolution_caps_auto_at_eight() {
        assert_eq!(decoder_pool(0, 2), 2);
        assert_eq!(decoder_pool(0, 8), 8);
        assert_eq!(decoder_pool(0, 16), 8);
        assert_eq!(decoder_pool(3, 16), 3);
    }

    /// Coordinate transform: photo pixel → 1024-resized space.
    /// For a 1600x1200 photo: scale = 1024/1600 = 0.64.
    /// resized_dimensions(1600, 1200) = (1024, 768).
    /// Point (800, 600) in photo → (800 * 1024/1600, 600 * 768/1200) = (512.0, 384.0).
    #[test]
    fn coord_transform_1600x1200_centre() {
        let (rw, rh) = resized_dimensions(1600, 1200);
        assert_eq!((rw, rh), (1024, 768));
        let photo_x = 800.0_f32;
        let photo_y = 600.0_f32;
        let enc_x = photo_x * rw as f32 / 1600.0;
        let enc_y = photo_y * rh as f32 / 1200.0;
        assert!((enc_x - 512.0).abs() < 1e-4, "enc_x={enc_x}");
        assert!((enc_y - 384.0).abs() < 1e-4, "enc_y={enc_y}");
    }

    /// Mask-to-bbox at 256px maps back correctly to photo pixels.
    /// Synthetic 10x8 mask with a 3x2 foreground block at (2,3)→(4,4).
    /// Mask dims: 256x192 for a 1600x1200 photo (mask_side=256).
    /// Bbox in mask space: [2,3,3,2]; sx=1600/256=6.25, sy=1200/192=6.25.
    /// Photo bbox: x0=floor(2*6.25)=12, y0=floor(3*6.25)=18,
    ///             x1=ceil(5*6.25)=32, y1=ceil(5*6.25)=32 → [12,18,20,14].
    #[test]
    fn mask_to_bbox_at_256px_maps_back_to_photo_pixels() {
        // Build a synthetic 10x8 mask with foreground at columns 2..=4, rows 3..=4.
        let mut mask_f32 = vec![-1.0_f32; 10 * 8];
        for y in 3..=4_usize {
            for x in 2..=4_usize {
                mask_f32[y * 10 + x] = 1.0;
            }
        }
        let seg = mask_segment(&mask_f32, 10, 8, 0.95).unwrap();
        assert_eq!(seg.bbox, [2., 3., 3., 2.]);
        assert_eq!(seg.area, 6);

        // Scale to 100x80 photo space (sx=10, sy=10).
        let sx = 100.0_f64 / 10.0;
        let sy = 80.0_f64 / 8.0;
        let x0 = (seg.bbox[0] as f64 * sx).floor() as f32;
        let y0 = (seg.bbox[1] as f64 * sy).floor() as f32;
        let x1 = ((seg.bbox[0] + seg.bbox[2]) as f64 * sx).ceil().min(100.0) as f32;
        let y1 = ((seg.bbox[1] + seg.bbox[3]) as f64 * sy).ceil().min(80.0) as f32;
        assert_eq!(x0, 20.0);
        assert_eq!(y0, 30.0);
        assert_eq!(x1, 50.0);
        assert_eq!(y1, 50.0);
    }

    #[test]
    fn mock_point_segmenter_counts_encode_calls() {
        let mock = MockPointSegmenter::default();
        assert_eq!(mock.encode_calls(), 0);
        mock.encode(&[]).expect("mock encode 1");
        assert_eq!(mock.encode_calls(), 1);
        mock.encode(&[]).expect("mock encode 2");
        assert_eq!(mock.encode_calls(), 2);
    }

    #[test]
    fn mock_point_segmenter_decode_returns_configured_segment() {
        let expected_seg = Segment {
            bbox: [10., 20., 50., 60.],
            score: 0.95,
            area: 3000,
        };
        let mock = MockPointSegmenter::new(expected_seg.clone(), 256, 192);
        let enc = ImageEncoding::mock();
        let pts = [PointPrompt {
            x: 800.,
            y: 600.,
            label: 1,
        }];
        let result = mock.decode_points(&enc, &pts).expect("mock decode");
        assert_eq!(result.segment, expected_seg);
        assert_eq!(result.mask.width(), 256);
        assert_eq!(result.mask.height(), 192);
        // All pixels should be 255 (fully foreground).
        assert!(result.mask.pixels().all(|p| p[0] == 255));
    }
}
