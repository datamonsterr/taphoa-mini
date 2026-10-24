//! Real-model acceptance tests; skip only when weights or the dynamic runtime are absent.
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use taphoa_recognition::ocr::{PpOcrDetector, ReceiptOcr, TextDetector, VietOcr};

fn model(var: &str, file: &str) -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models");
    let path = std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(file));
    path.is_file().then_some(path)
}
fn adapters() -> Option<(Arc<PpOcrDetector>, VietOcr)> {
    if !std::env::var_os("ORT_DYLIB_PATH").is_some_and(|p| PathBuf::from(p).is_file()) {
        return None;
    }
    let det = model("OCR_DET_PATH", "ocr_det.onnx")?;
    let enc = model("OCR_ENCODER_PATH", "ocr_vietocr_encoder.onnx")?;
    let dec = model("OCR_DECODER_PATH", "ocr_vietocr_decoder.onnx")?;
    let vocab = model("OCR_VOCAB_PATH", "ocr_vietocr.json")?;
    let detector = Arc::new(PpOcrDetector::load(&det, 4).expect("load detector"));
    let ocr = VietOcr::load(detector.clone(), &enc, &dec, &vocab, 4).expect("load VietOCR");
    Some((detector, ocr))
}
fn area_ratio(detector: &PpOcrDetector, bytes: &[u8]) -> f32 {
    let image = image::load_from_memory(bytes).unwrap();
    detector
        .detect(bytes)
        .unwrap()
        .iter()
        .map(|b| b.bbox[2] * b.bbox[3])
        .sum::<f32>()
        / (image.width() as f32 * image.height() as f32)
}
fn compact(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}
fn money(n: u64) -> String {
    let s = n.to_string();
    s.chars()
        .enumerate()
        .fold(String::new(), |mut out, (i, c)| {
            if i > 0 && (s.len() - i).is_multiple_of(3) {
                out.push('.');
            }
            out.push(c);
            out
        })
}

#[test]
fn receipt_accuracy_document_signal_and_latency() {
    let Some((detector, ocr)) = adapters() else {
        eprintln!("SKIP OCR: fetch models and set ORT_DYLIB_PATH + OCR_*_PATH");
        return;
    };
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/receipts");
    let mut failures = Vec::new();
    for n in 1..=3 {
        let bytes = std::fs::read(fixtures.join(format!("receipt-{n}.jpg"))).unwrap();
        let expected: serde_json::Value = serde_json::from_slice(
            &std::fs::read(fixtures.join(format!("receipt-{n}.json"))).unwrap(),
        )
        .unwrap();
        let t = Instant::now();
        let signal = detector
            .document_signal(&bytes)
            .expect("document detection");
        let det_ms = t.elapsed().as_secs_f64() * 1000.;
        if !signal.detected {
            failures.push(format!("receipt-{n}: {signal:?}"));
        }
        let t = Instant::now();
        let lines = ocr.read_lines(&bytes).expect("OCR");
        let elapsed = t.elapsed().as_secs_f64() * 1000.;
        let text = lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let ratio = area_ratio(&detector, &bytes);
        eprintln!(
            "receipt-{n}: det={det_ms:.0}ms e2e={elapsed:.0}ms area_ratio={ratio:.4} signal={signal:?}\n{text}"
        );
        if elapsed >= 2500. {
            failures.push(format!(
                "receipt-{n}: {elapsed:.0}ms exceeds 2500ms on four threads"
            ));
        }
        for line in &lines {
            assert!(line.confidence.is_finite() && (0. ..=1.).contains(&line.confidence));
            let [x, y, w, h] = line.bbox;
            assert!(x >= 0. && y >= 0. && w > 0. && h > 0.);
        }
        let text = compact(&text);
        for item in expected["lines"].as_array().unwrap() {
            let name = compact(item["product_name"].as_str().unwrap());
            if !text.contains(&name) {
                failures.push(format!("receipt-{n}: missing {name}"));
            }
            let cost = money(item["cost"].as_u64().unwrap());
            if !text.contains(&cost) {
                failures.push(format!("receipt-{n}: missing {cost}"));
            }
        }
        if !text.contains(&money(expected["total"].as_u64().unwrap())) {
            failures.push(format!("receipt-{n}: missing total"));
        }
        if n == 1 {
            assert!(
                lines
                    .iter()
                    .any(|l| compact(&l.text).contains("TênhàngSLĐơngiáT.Tiền")),
                "header columns must be grouped"
            );
        }
    }
    for name in ["shelf-1024.jpg", "shelf-1600.jpg", "sample.png"] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures")
            .join(name);
        let bytes = std::fs::read(path).unwrap();
        let signal = detector.document_signal(&bytes).unwrap();
        let ratio = area_ratio(&detector, &bytes);
        eprintln!("{name}: area_ratio={ratio:.4} {signal:?}");
        if signal.detected {
            failures.push(format!(
                "product photo {name} detected as a document: {signal:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
