//! Production model families and the adapters used by their HTTP/internal callers.
use crate::{
    ApiResult, AppState,
    config::Config,
    model_holder::{ModelHolder, ModelLease},
};
use std::{sync::Arc, time::Duration};
use taphoa_recognition::{
    Embedder, PointSegmenter, SamSegmenter, Segmenter,
    ocr::{ReceiptOcr, TextDetector, VietOcr},
};

#[derive(Clone, Default)]
pub struct LazyModels {
    pub sam: Option<ModelHolder<SamSegmenter>>,
    pub dino: Option<ModelHolder<dyn Embedder>>,
    pub ocr: Option<ModelHolder<VietOcr>>,
}
impl LazyModels {
    /// Only check configuration/files here. ORT and warm-up run inside each holder's loader.
    pub fn from_config(config: &Config) -> anyhow::Result<Self> {
        let idle = Duration::from_secs(config.model_idle_unload_secs);
        let sam = match (&config.encoder, &config.decoder) {
            (None, None) => None,
            (Some(enc), Some(dec)) if !enc.exists() && !dec.exists() => None,
            (Some(_), Some(_)) => {
                let config = config.clone();
                Some(ModelHolder::new("sam", idle, move || {
                    config
                        .sam_segmenter()?
                        .ok_or_else(|| anyhow::anyhow!("SAM weights absent"))
                }))
            }
            _ => anyhow::bail!("set both SAM_ENCODER_PATH and SAM_DECODER_PATH, or neither"),
        };
        let dino = config
            .dino_model
            .as_ref()
            .filter(|path| path.exists())
            .map(|_| {
                let config = config.clone();
                ModelHolder::new("dinov2", idle, move || {
                    config
                        .embedder()?
                        .ok_or_else(|| anyhow::anyhow!("DINOv2 weights absent"))
                })
            });
        let ocr = config
            .ocr_det
            .as_ref()
            .filter(|path| path.exists())
            .map(|_| {
                let config = config.clone();
                ModelHolder::new("ocr", idle, move || {
                    config
                        .ocr()?
                        .ok_or_else(|| anyhow::anyhow!("OCR weights absent"))
                })
            });
        Ok(Self { sam, dino, ocr })
    }
}
fn load_error(error: anyhow::Error) -> crate::ApiError {
    tracing::warn!(%error, "model unavailable");
    crate::busy()
}
impl AppState {
    pub fn embedding_holder(&self) -> Option<ModelHolder<dyn Embedder>> {
        self.embedder
            .clone()
            .map(ModelHolder::from)
            .or_else(|| self.models.dino.clone())
    }
    pub async fn model_segmenter(&self) -> ApiResult<Option<ModelLease<dyn Segmenter>>> {
        if let Some(model) = &self.segmenter {
            return Ok(Some(ModelLease::fixed(model.clone())));
        }
        match &self.models.sam {
            Some(holder) => Ok(Some(
                holder
                    .get()
                    .await
                    .map_err(load_error)?
                    .map(|model| model.clone() as Arc<dyn Segmenter>),
            )),
            None => Ok(None),
        }
    }
    pub async fn model_point_segmenter(&self) -> ApiResult<Option<ModelLease<dyn PointSegmenter>>> {
        if let Some(model) = &self.point_segmenter {
            return Ok(Some(ModelLease::fixed(model.clone())));
        }
        match &self.models.sam {
            Some(holder) => Ok(Some(
                holder
                    .get()
                    .await
                    .map_err(load_error)?
                    .map(|model| model.clone() as Arc<dyn PointSegmenter>),
            )),
            None => Ok(None),
        }
    }
    pub async fn model_embedder(&self) -> ApiResult<Option<ModelLease<dyn Embedder>>> {
        match self.embedding_holder() {
            Some(holder) => Ok(Some(holder.get().await.map_err(load_error)?)),
            None => Ok(None),
        }
    }
    pub async fn model_text_detector(&self) -> ApiResult<Option<ModelLease<dyn TextDetector>>> {
        if let Some(model) = &self.text_detector {
            return Ok(Some(ModelLease::fixed(model.clone())));
        }
        match &self.models.ocr {
            Some(holder) => Ok(Some(
                holder
                    .get()
                    .await
                    .map_err(load_error)?
                    .map(|model| model.detector()),
            )),
            None => Ok(None),
        }
    }
    pub async fn model_receipt_ocr(&self) -> ApiResult<Option<ModelLease<dyn ReceiptOcr>>> {
        if let Some(model) = &self.receipt_ocr {
            return Ok(Some(ModelLease::fixed(model.clone())));
        }
        match &self.models.ocr {
            Some(holder) => Ok(Some(
                holder
                    .get()
                    .await
                    .map_err(load_error)?
                    .map(|model| model.clone() as Arc<dyn ReceiptOcr>),
            )),
            None => Ok(None),
        }
    }
}

impl<T: Embedder + 'static> From<Arc<T>> for ModelHolder<dyn Embedder> {
    fn from(model: Arc<T>) -> Self {
        let model: Arc<dyn Embedder> = model;
        ModelHolder::from(model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn startup_and_health_do_not_open_even_invalid_model_files() {
        let file = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        let config = Config::from_lookup(|name| match name {
            "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
            "SAM_ENCODER_PATH" | "SAM_DECODER_PATH" | "DINO_MODEL_PATH" | "OCR_DET_PATH"
            | "OCR_ENCODER_PATH" | "OCR_DECODER_PATH" | "OCR_VOCAB_PATH" => Some(file.into()),
            _ => None,
        })
        .unwrap();
        let models = LazyModels::from_config(&config).unwrap();
        assert!(models.sam.is_some() && models.dino.is_some() && models.ocr.is_some());
        let state = AppState {
            models,
            ..AppState::default()
        };
        let app = crate::router(state);
        for (path, status) in [
            ("/healthz", StatusCode::OK),
            ("/readyz", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let response = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
    }
}
