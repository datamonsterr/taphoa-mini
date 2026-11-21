use std::{path::PathBuf, sync::Arc};
use taphoa_infer::{Models, Service};
use taphoa_recognition::{
    DinoEmbedder, Embedder, PointPrompt, PointSegmenter, SamOptions, SamSegmenter, Segmenter,
    ocr::{ReceiptOcr, VietOcr},
    provider::Provider,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let token = std::env::var("INFERENCE_TOKEN")
        .map_err(|_| anyhow::anyhow!("INFERENCE_TOKEN is required (at least 32 characters)"))?;
    anyhow::ensure!(
        token.chars().count() >= 32,
        "INFERENCE_TOKEN must contain at least 32 characters"
    );
    let bind = std::env::var("INFERENCE_BIND").unwrap_or_else(|_| "127.0.0.1:8090".into());
    let provider = Provider::from_env().map_err(anyhow::Error::msg)?;
    // No socket/readiness until sessions and all inference paths have been warmed.
    let models = tokio::task::spawn_blocking(load_and_warm).await??;
    let service = Service::new(models, &token, provider.name())?;
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind,provider=provider.name(),"inference worker ready");
    axum::serve(listener, service.router())
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        })
        .await?;
    Ok(())
}
fn path(variable: &str, filename: &str) -> PathBuf {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("MODEL_DIR").unwrap_or_else(|| "models".into()))
                .join(filename)
        })
}
fn load_and_warm() -> anyhow::Result<Models> {
    let sam = Arc::new(SamSegmenter::load(
        &path("SAM_ENCODER_PATH", "mobile_sam_image_encoder.onnx"),
        &path("SAM_DECODER_PATH", "sam_mask_decoder_multi.onnx"),
        SamOptions::from_env(),
    )?);
    let dino = Arc::new(DinoEmbedder::load(
        &path("DINO_MODEL_PATH", "dinov2_small.onnx"),
        4,
    )?);
    let ocr = Arc::new(VietOcr::load_paths(
        &path("OCR_DET_PATH", "ocr_det.onnx"),
        &path("OCR_ENCODER_PATH", "ocr_vietocr_encoder.onnx"),
        &path("OCR_DECODER_PATH", "ocr_vietocr_decoder.onnx"),
        &path("OCR_VOCAB_PATH", "ocr_vietocr.json"),
        4,
    )?);
    // Uniform small photo exercises encoder, decoder, embedding and detector.
    let image = image::RgbImage::from_pixel(320, 240, image::Rgb([128, 128, 128]));
    let mut photo = Vec::new();
    image.write_to(
        &mut std::io::Cursor::new(&mut photo),
        image::ImageFormat::Png,
    )?;
    sam.segment(&photo)?;
    let encoding = sam.encode(&photo)?;
    sam.decode_points(
        &encoding,
        &[PointPrompt {
            x: 160.,
            y: 120.,
            label: 1,
        }],
    )?;
    dino.embed(&photo)?;
    ocr.detector().detect(&photo)?;
    ocr.read_lines(&photo)?;
    // A blank detector can yield no lines. Explicitly exercise the recognizer too.
    ocr.warm_recognizer(&image)?;
    Ok(Models {
        segmenter: sam.clone(),
        points: sam,
        embedder: dino,
        detector: ocr.detector(),
        ocr,
    })
}
