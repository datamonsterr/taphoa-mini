use std::path::PathBuf;
use taphoa_recognition::{SamOptions, SamSegmenter, Segmenter};

#[test]
fn sam_end_to_end() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let encoder = std::env::var_os("SAM_ENCODER_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("models/sam_vit_b_encoder.onnx"));
    let decoder = std::env::var_os("SAM_DECODER_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("models/sam_vit_b_decoder.onnx"));
    if !encoder.is_file() || !decoder.is_file() {
        eprintln!("SKIP SAM end-to-end: run scripts/fetch-models.sh and configure ORT_DYLIB_PATH");
        return;
    }
    let sam = SamSegmenter::load(&encoder, &decoder, SamOptions::default())
        .expect("load SAM encoder + decoder");
    let bytes = include_bytes!("../../../tests/fixtures/sample.png");
    let segments = sam
        .segment(bytes)
        .expect("SAM encoder and automatic point-grid decoder inference");
    assert!(
        !segments.is_empty(),
        "sample objects should produce at least one filtered mask"
    );
    for segment in &segments {
        let [x, y, w, h] = segment.bbox;
        assert!(x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0);
        assert!(x + w <= 128.0 && y + h <= 96.0);
        assert!(segment.score.is_finite() && segment.score >= 0.88);
        assert!(segment.area >= 64 && segment.area as f32 <= w * h);
    }
    eprintln!(
        "SAM end-to-end: {} filtered segments from 64 prompts",
        segments.len()
    );
    assert!(matches!(
        sam.segment(b"invalid"),
        Err(taphoa_recognition::SegmentError::InvalidImage(_))
    ));
}
