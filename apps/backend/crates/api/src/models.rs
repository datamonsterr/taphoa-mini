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
    pub fn shutdown(&self) {
        if let Some(holder) = &self.sam {
            holder.shutdown();
        }
        if let Some(holder) = &self.dino {
            holder.shutdown();
        }
        if let Some(holder) = &self.ocr {
            holder.shutdown();
        }
    }

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
        let (embedder_path, model_name, path_var) = if config.embedder_name == "siglip2" {
            (
                config.siglip2_model.as_deref(),
                "siglip2",
                "SIGLIP2_MODEL_PATH",
            )
        } else {
            (config.dino_model.as_deref(), "dinov2", "DINO_MODEL_PATH")
        };
        let dino = match (config.embedder_name.as_str(), embedder_path) {
            ("mock", _) => None,
            ("siglip2", None) => {
                anyhow::bail!("selected embedder 'siglip2' requires SIGLIP2_MODEL_PATH to be set");
            }
            (_, Some(path)) if !path.exists() => {
                anyhow::bail!(
                    "selected embedder '{model_name}' model file not found ({path_var}={}): file does not exist",
                    path.display()
                );
            }
            (_, Some(_)) => {
                let config = config.clone();
                Some(ModelHolder::new(model_name, idle, move || {
                    config
                        .embedder()?
                        .ok_or_else(|| anyhow::anyhow!("embedder weights absent"))
                }))
            }
            _ => None,
        };
        let ocr = match (
            &config.ocr_det,
            &config.ocr_encoder,
            &config.ocr_decoder,
            &config.ocr_vocab,
        ) {
            (None, None, None, None) => None,
            (Some(det), Some(enc), Some(dec), Some(vocab))
                if [det, enc, dec, vocab].iter().all(|path| !path.exists()) =>
            {
                None
            }
            (Some(_), Some(_), Some(_), Some(_)) => {
                let config = config.clone();
                Some(ModelHolder::new("ocr", idle, move || {
                    config
                        .ocr()?
                        .ok_or_else(|| anyhow::anyhow!("OCR weights absent"))
                }))
            }
            _ => anyhow::bail!("set all four OCR paths, or none"),
        };
        Ok(Self { sam, dino, ocr })
    }
}
fn load_error(error: anyhow::Error) -> crate::ApiError {
    tracing::warn!(%error, "model unavailable");
    crate::busy()
}
impl AppState {
    pub fn embedding_holder(&self) -> Option<ModelHolder<dyn Embedder>> {
        if let Some(remote) = &self.remote_models {
            return Some(ModelHolder::from(remote.clone() as Arc<dyn Embedder>));
        }
        self.embedder
            .clone()
            .map(ModelHolder::from)
            .or_else(|| self.models.dino.clone())
    }
    pub async fn model_segmenter(&self) -> ApiResult<Option<ModelLease<dyn Segmenter>>> {
        if let Some(remote) = &self.remote_models {
            return Ok(Some(
                ModelLease::fixed(remote.clone() as Arc<dyn Segmenter>),
            ));
        }
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
        if let Some(remote) = &self.remote_models {
            return Ok(Some(ModelLease::fixed(
                remote.clone() as Arc<dyn PointSegmenter>
            )));
        }
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
        if let Some(remote) = &self.remote_models {
            return Ok(Some(ModelLease::fixed(remote.clone() as Arc<dyn Embedder>)));
        }
        match self.embedding_holder() {
            Some(holder) => Ok(Some(holder.get().await.map_err(load_error)?)),
            None => Ok(None),
        }
    }
    pub async fn model_text_detector(&self) -> ApiResult<Option<ModelLease<dyn TextDetector>>> {
        if let Some(remote) = &self.remote_models {
            return Ok(Some(ModelLease::fixed(
                remote.clone() as Arc<dyn TextDetector>
            )));
        }
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
        if let Some(remote) = &self.remote_models {
            return Ok(Some(ModelLease::fixed(
                remote.clone() as Arc<dyn ReceiptOcr>
            )));
        }
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
    use axum::response::IntoResponse;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use std::path::PathBuf;
    use tower::ServiceExt;

    #[tokio::test]
    async fn partial_ocr_files_create_a_holder_and_return_retryable_load_errors() {
        let present = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        let absent =
            std::env::temp_dir().join(format!("taphoa-ocr-missing-{}", uuid::Uuid::new_v4()));
        let keys = [
            "OCR_DET_PATH",
            "OCR_ENCODER_PATH",
            "OCR_DECODER_PATH",
            "OCR_VOCAB_PATH",
        ];
        // Cover each partial set, especially a missing detector with another file present.
        for mask in 0u8..16 {
            let config = Config::from_lookup(|name| {
                if name == "CLERK_ISSUER" {
                    return Some("https://local.clerk.accounts.dev".into());
                }
                keys.iter().position(|key| *key == name).map(|index| {
                    if mask & (1 << index) != 0 {
                        present.to_owned()
                    } else {
                        absent.to_string_lossy().into_owned()
                    }
                })
            })
            .unwrap();
            let models = LazyModels::from_config(&config).unwrap();
            assert_eq!(models.ocr.is_some(), mask != 0, "file mask {mask}");
            if mask == 0 || mask == 15 {
                continue;
            }
            let cause = models
                .ocr
                .as_ref()
                .unwrap()
                .get()
                .await
                .err()
                .expect("partial load fails");
            assert!(
                cause
                    .to_string()
                    .contains("OCR model files must all be present")
            );
            let state = AppState {
                models,
                ..AppState::default()
            };
            let response = state
                .model_receipt_ocr()
                .await
                .err()
                .expect("retryable OCR error")
                .into_response();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()["retry-after"], "1");
        }
    }

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

    #[tokio::test]
    async fn optional_siglip2_model_is_not_loaded_by_default() {
        let file = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");

        let default_config = Config::from_lookup(|name| match name {
            "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
            "DINO_MODEL_PATH" => Some(file.into()),
            "SIGLIP2_MODEL_PATH" => Some(file.into()),
            _ => None,
        })
        .unwrap();
        let default_models = LazyModels::from_config(&default_config).unwrap();
        let default_holder = default_models.dino.expect("embedder holder configured");
        assert_eq!(default_holder.family(), "dinov2");

        let siglip_config = Config::from_lookup(|name| match name {
            "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
            "EMBEDDER" => Some("siglip2".into()),
            "DINO_MODEL_PATH" => Some(file.into()),
            "SIGLIP2_MODEL_PATH" => Some(file.into()),
            _ => None,
        })
        .unwrap();
        let siglip_models = LazyModels::from_config(&siglip_config).unwrap();
        let siglip_holder = siglip_models.dino.expect("embedder holder configured");
        assert_eq!(siglip_holder.family(), "siglip2");
    }

    #[tokio::test]
    async fn startup_fails_with_clear_error_when_selected_embedder_model_is_missing() {
        let missing = PathBuf::from("/nonexistent/model/siglip2.onnx");

        // 1. SigLIP2 selected, file missing
        let siglip_missing_config = Config::from_lookup(|name| match name {
            "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
            "EMBEDDER" => Some("siglip2".into()),
            "SIGLIP2_MODEL_PATH" => Some(missing.to_string_lossy().into()),
            _ => None,
        })
        .unwrap();
        let err = LazyModels::from_config(&siglip_missing_config)
            .err()
            .expect("startup must fail on missing siglip2 model file");
        assert!(
            err.to_string()
                .contains("selected embedder 'siglip2' model file not found"),
            "unexpected error message: {err}"
        );

        // 2. SigLIP2 selected, path unset
        let siglip_unset_config = Config::from_lookup(|name| match name {
            "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
            "EMBEDDER" => Some("siglip2".into()),
            _ => None,
        })
        .unwrap();
        let err2 = LazyModels::from_config(&siglip_unset_config)
            .err()
            .expect("startup must fail when siglip2 path unset");
        assert!(
            err2.to_string()
                .contains("selected embedder 'siglip2' requires SIGLIP2_MODEL_PATH to be set"),
            "unexpected error message: {err2}"
        );

        // 3. DINOv2 selected, file missing
        let dino_missing_config = Config::from_lookup(|name| match name {
            "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
            "EMBEDDER" => Some("dinov2".into()),
            "DINO_MODEL_PATH" => Some(missing.to_string_lossy().into()),
            _ => None,
        })
        .unwrap();
        let err3 = LazyModels::from_config(&dino_missing_config)
            .err()
            .expect("startup must fail on missing dinov2 model file");
        assert!(
            err3.to_string()
                .contains("selected embedder 'dinov2' model file not found"),
            "unexpected error message: {err3}"
        );
    }
}
