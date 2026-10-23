//! Model tests: skipped (with a message) unless the ONNX weights and runtime are present.
//! Run `scripts/fetch-models.sh`, `scripts/fetch-onnxruntime.sh` and set `ORT_DYLIB_PATH`.
use std::{path::PathBuf, time::Instant};
use taphoa_recognition::{
    DinoEmbedder, Embedder, SamOptions, SamSegmenter, Segmenter, crop::crop_with_padding,
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
