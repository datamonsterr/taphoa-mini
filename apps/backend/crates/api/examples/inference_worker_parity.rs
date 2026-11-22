//! Real CPU vs remote-worker parity. Run via the shared heavy wrapper.
use std::{path::PathBuf, sync::Arc};
use taphoa_api::{AppState, remote_models::RemoteModels};
use taphoa_recognition::{
    DinoEmbedder, Embedder, PointPrompt, PointSegmenter, SamOptions, SamSegmenter, Segmenter,
    ocr::{ReceiptOcr, VietOcr},
};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let remote = Arc::new(RemoteModels::new(
        &std::env::var("INFERENCE_URL")?,
        &std::env::var("INFERENCE_TOKEN")?,
        AppState::default(),
    )?);
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let monitor = remote.spawn_monitor(stopped);
    let result = async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !remote.healthy() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("worker health check failed"))?;
        tokio::task::spawn_blocking(move || run(remote)).await?
    }
    .await;
    stop.send_replace(true);
    monitor.await?;
    result?;
    Ok(())
}
fn run(remote: Arc<RemoteModels>) -> anyhow::Result<()> {
    let root = PathBuf::from(std::env::var("MODEL_DIR")?);
    let sam = SamSegmenter::load(
        &root.join("mobile_sam_image_encoder.onnx"),
        &root.join("sam_mask_decoder_multi.onnx"),
        SamOptions {
            threads: 4,
            decoders: 4,
            ..SamOptions::default()
        },
    )?;
    let dino = DinoEmbedder::load(&root.join("dinov2_small.onnx"), 4)?;
    let ocr = VietOcr::load_paths(
        &root.join("ocr_det.onnx"),
        &root.join("ocr_vietocr_encoder.onnx"),
        &root.join("ocr_vietocr_decoder.onnx"),
        &root.join("ocr_vietocr.json"),
        4,
    )?;
    let backend = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let photo = std::fs::read(backend.join("tests/fixtures/shelf-1600.jpg"))?;
    let a = sam.segment(&photo)?;
    let b = remote.segment(&photo)?;
    anyhow::ensure!(
        a.len() == b.len(),
        "segment count {} != {}",
        a.len(),
        b.len()
    );
    let x = dino.embed(&photo)?;
    let y = remote.embed(&photo)?;
    let embedding_cosine = cosine(&x, &y);
    anyhow::ensure!(embedding_cosine >= 0.9999, "cosine {embedding_cosine}");
    let enc_a = sam.encode(&photo)?;
    let enc_b = remote.encode(&photo)?;
    let mut min_iou = 1.0f64;
    for gy in 0..8 {
        for gx in 0..8 {
            let point = [PointPrompt {
                x: (gx as f32 + 0.5) * enc_a.width as f32 / 8.,
                y: (gy as f32 + 0.5) * enc_a.height as f32 / 8.,
                label: 1,
            }];
            let ma = sam.decode_points(&enc_a, &point)?.mask;
            let mb = remote.decode_points(&enc_b, &point)?.mask;
            anyhow::ensure!(ma.dimensions() == mb.dimensions());
            let mut union = 0;
            let mut intersection = 0;
            for (a, b) in ma.as_raw().iter().zip(mb.as_raw()) {
                if *a != 0 || *b != 0 {
                    union += 1;
                }
                if *a != 0 && *b != 0 {
                    intersection += 1;
                }
            }
            let iou = if union == 0 {
                1.
            } else {
                intersection as f64 / union as f64
            };
            min_iou = min_iou.min(iou);
            anyhow::ensure!(iou >= 0.99, "mask IoU {iou}");
        }
    }
    let rgb = taphoa_recognition::crop::decode_limited(&photo)
        .map_err(anyhow::Error::msg)?
        .to_rgb8();
    let crops: Vec<_> = a
        .iter()
        .filter_map(|s| taphoa_recognition::crop::crop_with_padding(&rgb, s.bbox, 0.08))
        .collect();
    let cpu = dino.embed_crops(&crops)?;
    let gpu = remote.embed_crops(&crops)?;
    let crop_cosine = cpu
        .iter()
        .zip(&gpu)
        .map(|(a, b)| cosine(a, b))
        .fold(1.0, f64::min);
    anyhow::ensure!(crop_cosine >= 0.9999);
    let mut receipts = Vec::new();
    for i in 1..=3 {
        let photo = std::fs::read(backend.join(format!(
            "crates/recognition/tests/fixtures/receipts/receipt-{i}.jpg"
        )))?;
        let cpu = ocr.read_lines(&photo)?;
        let gpu = remote.read_lines(&photo)?;
        let a: Vec<_> = cpu.iter().map(|l| &l.text).collect();
        let b: Vec<_> = gpu.iter().map(|l| &l.text).collect();
        anyhow::ensure!(a == b, "receipt {i} text mismatch");
        receipts.push(a.len());
    }
    println!(
        "{}",
        serde_json::json!({"segments":a.len(),"embedding_cosine":embedding_cosine,"crop_min_cosine":crop_cosine,"point_masks":64,"min_mask_iou":min_iou,"receipt_line_counts":receipts,"ocr_identical":true})
    );
    Ok(())
}
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let dot: f64 = a
        .iter()
        .zip(b)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    let norm = |x: &[f32]| x.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt();
    dot / (norm(a) * norm(b))
}
