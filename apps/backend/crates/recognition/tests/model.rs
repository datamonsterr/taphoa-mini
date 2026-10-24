//! Model tests: skipped (with a message) unless the ONNX weights and runtime are present.
//! Run `scripts/fetch-models.sh`, `scripts/fetch-onnxruntime.sh` and set `ORT_DYLIB_PATH`.
use std::{path::PathBuf, time::Instant};
use taphoa_recognition::{
    DinoEmbedder, Embedder, PointPrompt, PointSegmenter, SamOptions, SamSegmenter, Segmenter,
    crop::crop_with_padding,
};

fn model(var: &str, file: &str) -> Option<PathBuf> {
    // Without a loadable runtime (ORT_DYLIB_PATH) the model tests skip rather than fail.
    if !std::env::var_os("ORT_DYLIB_PATH").is_some_and(|p| PathBuf::from(p).is_file()) {
        return None;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let path = std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("models").join(file));
    path.is_file().then_some(path)
}

fn sam() -> Option<SamSegmenter> {
    let encoder = model("SAM_ENCODER_PATH", "mobile_sam_image_encoder.onnx")?;
    let decoder = model("SAM_DECODER_PATH", "sam_mask_decoder_multi.onnx")?;
    // The budget assumes the 4 vCPU deployment target; SAM_THREADS overrides.
    let mut options = SamOptions::from_env();
    if std::env::var_os("SAM_THREADS").is_none() {
        options.threads = 4;
    }
    Some(SamSegmenter::load(&encoder, &decoder, options).expect("load SAM"))
}

#[test]
fn sam_end_to_end_small_image() {
    let Some(sam) = sam() else {
        eprintln!("SKIP SAM: run scripts/fetch-models.sh and configure ORT_DYLIB_PATH");
        return;
    };
    let bytes = include_bytes!("../../../tests/fixtures/sample.png");
    let segments = sam.segment(bytes).expect("SAM inference");
    for segment in &segments {
        let [x, y, w, h] = segment.bbox;
        assert!(x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0);
        assert!(x + w <= 128.0 && y + h <= 96.0);
        assert!(segment.score.is_finite() && segment.score >= 0.88);
    }
    assert!(matches!(
        sam.segment(b"invalid"),
        Err(taphoa_recognition::SegmentError::InvalidImage(_))
    ));
}

/// Budget for the segmentation part of a scan (docs/architecture.md §5.3): the whole request
/// must stay under 3 s, so SAM gets 2.2 s on a 4-core machine. Override with SAM_MAX_MS.
#[test]
fn sam_segments_1600px_photo_within_budget() {
    let Some(sam) = sam() else {
        eprintln!("SKIP SAM latency: models not present");
        return;
    };
    let bytes = include_bytes!("../../../tests/fixtures/shelf-1600.jpg");
    let budget_ms: f64 = std::env::var("SAM_MAX_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2200.0);
    let mut best = f64::MAX;
    let mut count = 0;
    for _ in 0..3 {
        let t = Instant::now();
        let segments = sam.segment(bytes).expect("segment 1600 px photo");
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        count = segments.len();
    }
    eprintln!("SAM 1600px best of 3: {best:.0} ms, {count} segments");
    assert!(
        (10..=40).contains(&count),
        "18 products should yield roughly 18 segments, got {count}"
    );
    assert!(
        best < budget_ms,
        "segmentation {best:.0} ms >= {budget_ms} ms"
    );
}

#[test]
fn dino_embeds_crops_as_unit_vectors() {
    let Some(path) = model("DINO_MODEL_PATH", "dinov2_small.onnx") else {
        eprintln!("SKIP DINO: models not present");
        return;
    };
    let embedder = DinoEmbedder::load(&path, 0).expect("load DINOv2");
    assert_eq!(embedder.dim(), 384);
    let photo = image::load_from_memory(include_bytes!("../../../tests/fixtures/shelf-1600.jpg"))
        .unwrap()
        .to_rgb8();
    let a = crop_with_padding(&photo, [70., 60., 170., 300.], 0.08).unwrap();
    let b = crop_with_padding(&photo, [325., 60., 170., 300.], 0.08).unwrap();
    let t = Instant::now();
    let vectors = embedder.embed_crops(&[a.clone(), b, a]).expect("embed");
    eprintln!("DINO 3 crops: {:?}", t.elapsed());
    assert_eq!(vectors.len(), 3);
    for v in &vectors {
        assert_eq!(v.len(), 384);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4);
    }
    let dot = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>();
    assert!(dot(&vectors[0], &vectors[2]) > 0.999);
    assert!(dot(&vectors[0], &vectors[1]) < 0.99);
}

/// Point-prompted SAM test: prompt a point on a clearly isolated product in the shelf image
/// and assert IoU >= 0.8 vs the reference bbox from the automatic-mode segment.
///
/// Reference box derived from `probe_points` example and automatic-mode `SamSegmenter::segment`:
/// - Product #0 (leftmost top-row bottle), full bbox from auto-mode: [75,56,157,269] (x,y,w,h).
/// - Prompt at (154, 280) — bottom body of the bottle, away from the label — consistently
///   returns the full-product segment [75,56,157,269] with score ~1.007.
/// - Prompting the centre (154,190) targets the label sub-region and returns a smaller bbox;
///   bottom-body prompts (y≈80 or y≈280) target the main product and return the full bbox.
///
/// Timing assertions:
/// - encode + decode_points together < 1500 ms (4 threads, SAM_THREADS=4)
/// - second decode_points on same encoding < 400 ms
#[test]
fn sam_point_prompt_segments_one_product() {
    let Some(sam) = sam() else {
        eprintln!("SKIP point-prompt: models not present");
        return;
    };

    let bytes = include_bytes!("../../../tests/fixtures/shelf-1600.jpg");

    // Reference bbox from automatic-mode and probe_points for product #0 (leftmost top bottle).
    // Prompting (154, 280) — bottom body, clear of the label — returns [75,56,157,269].
    // Verified deterministic by probe_points example.
    let reference_bbox = [75_f32, 56., 157., 269.]; // [x, y, w, h] in photo pixels

    // Budget from spec (D2): point-prompted < 3 s total; the decode call < 400 ms.
    let total_budget_ms: f64 = std::env::var("SAM_MAX_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1500.0);
    let decode_budget_ms: f64 = 400.0;

    // --- encode ---
    let t_encode = Instant::now();
    let encoding = sam.encode(bytes).expect("encode shelf-1600");
    let encode_ms = t_encode.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "encode: {encode_ms:.0} ms  (image {}x{})",
        encoding.width, encoding.height
    );

    assert_eq!(encoding.width, 1600);
    assert_eq!(encoding.height, 1200);

    // --- first decode_points ---
    // Prompt the bottom body of product #0 (avoids the label sub-region at y≈190).
    // probe_points confirmed: (154, 280) → full product [75,56,157,269], score≈1.007.
    let prompt = [PointPrompt {
        x: 154.0,
        y: 280.0,
        label: 1,
    }];
    let t_decode1 = Instant::now();
    let result1 = sam
        .decode_points(&encoding, &prompt)
        .expect("decode_points");
    let decode1_ms = t_decode1.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "decode1: {decode1_ms:.0} ms  bbox={:?} score={:.3}",
        result1.segment.bbox, result1.segment.score
    );

    let total_ms = encode_ms + decode1_ms;
    eprintln!("encode + decode1 total: {total_ms:.0} ms  (budget {total_budget_ms} ms)");

    // Check IoU >= 0.8 vs reference.
    let iou = taphoa_recognition::bbox_iou(result1.segment.bbox, reference_bbox);
    eprintln!("IoU vs reference {reference_bbox:?}: {iou:.3}");
    assert!(
        iou >= 0.8,
        "IoU {iou:.3} < 0.8 — expected bbox ~{reference_bbox:?}, got {:?}",
        result1.segment.bbox
    );

    // Timing: encode + first decode < budget (1500 ms default).
    assert!(
        total_ms < total_budget_ms,
        "encode+decode {total_ms:.0} ms >= budget {total_budget_ms} ms"
    );

    // --- second decode_points on the SAME encoding (should be fast: only decoder, no encoder) ---
    let t_decode2 = Instant::now();
    let result2 = sam
        .decode_points(&encoding, &prompt)
        .expect("decode_points second call");
    let decode2_ms = t_decode2.elapsed().as_secs_f64() * 1000.0;
    eprintln!("decode2 (same encoding): {decode2_ms:.0} ms  (budget {decode_budget_ms} ms)");

    assert!(
        decode2_ms < decode_budget_ms,
        "second decode_points {decode2_ms:.0} ms >= {decode_budget_ms} ms"
    );

    // Both results should be identical (deterministic).
    assert_eq!(result1.segment.bbox, result2.segment.bbox);
    assert_eq!(result1.segment.score, result2.segment.score);

    // Mask dimensions: longest side = mask_side (256), aspect-preserving.
    // 1600x1200 → 256x192
    assert_eq!(result1.mask.width(), 256);
    assert_eq!(result1.mask.height(), 192);
    // Mask must have at least some foreground pixels near the prompt.
    let fg_count = result1.mask.pixels().filter(|p| p[0] == 255).count();
    assert!(
        fg_count > 100,
        "mask has too few foreground pixels: {fg_count}"
    );
    eprintln!(
        "mask {}x{}, fg_pixels={}",
        result1.mask.width(),
        result1.mask.height(),
        fg_count
    );
}
