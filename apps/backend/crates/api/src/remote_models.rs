//! Synchronous trait adapters, called only on the API's blocking pool. The saved
//! runtime handle drives async HTTP and the existing asynchronous lazy holders.
use crate::{ApiError, AppState, config::Config};
use serde::{Serialize, de::DeserializeOwned};
use std::future::Future;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use taphoa_recognition::{
    EmbedError, Embedder, ImageEncoding, PointPrompt, PointSegment, PointSegmenter, Segment,
    SegmentError, Segmenter,
    ocr::{DocumentSignal, OcrError, OcrLine, ReceiptOcr, TextBox, TextDetector},
    wire::{self, *},
};

// A trait call can issue several crop batches or an encoding retry. All of those
// sequential HTTP requests share one 10 s budget on the calling blocking thread.
thread_local! { static CALL_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) }; }
struct CallDeadline(Option<Instant>);
impl Drop for CallDeadline {
    fn drop(&mut self) {
        CALL_DEADLINE.set(self.0);
    }
}

const BREAKER_DELAY: Duration = Duration::from_secs(30);
#[derive(Debug)]
enum Circuit {
    Closed(u64),
    Open { until: Instant, generation: u64 },
    HalfOpen(u64),
}
struct Ticket {
    generation: u64,
}
// Cancellation of an async warm probe must not strand the circuit half-open.
struct AttemptGuard<'a> {
    remote: &'a RemoteModels,
    ticket: Option<Ticket>,
}
impl Drop for AttemptGuard<'_> {
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket.take() {
            self.remote.finish(ticket, true);
        }
    }
}
#[derive(Debug)]
enum CallError {
    Unavailable(&'static str),
    Client(RemoteError),
    UnknownEncoding,
}
impl From<RemoteError> for CallError {
    fn from(e: RemoteError) -> Self {
        Self::Client(e)
    }
}

/// Plaintext is safe only on loopback or an explicitly encrypted outer transport.
pub(crate) fn validate_url(url: &str, allow_plaintext: bool) -> anyhow::Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url)?;
    anyhow::ensure!(
        matches!(parsed.scheme(), "http" | "https")
            && parsed.host().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "INFERENCE_URL must be an HTTP(S) URL without credentials, query or fragment"
    );
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']');
    let loopback = host.trim_end_matches('.').eq_ignore_ascii_case("localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
            std::net::IpAddr::V4(ip) => ip.is_loopback(),
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
            }
        });
    anyhow::ensure!(
        parsed.scheme() == "https" || loopback || allow_plaintext,
        "INFERENCE_URL requires https:// for non-loopback hosts; INFERENCE_ALLOW_PLAINTEXT=1 is only for a transport that is already encrypted, such as a private WireGuard network"
    );
    Ok(parsed)
}

pub struct RemoteModels {
    url: String,
    token: String,
    client: reqwest::Client,
    circuit: Mutex<Circuit>,
    runtime: tokio::runtime::Handle,
    local: AppState,
    model: String,
}
struct RemoteEncoding {
    image: Arc<[u8]>,
    handle: Mutex<Option<String>>,
    // Local encodings can outlive unloaded SAM sessions, just as before.
    local: Mutex<Option<Arc<ImageEncoding>>>,
}
impl RemoteModels {
    pub fn from_config(config: &Config, local: AppState) -> anyhow::Result<Option<Arc<Self>>> {
        match (&config.inference_url, &config.inference_token) {
            (Some(url), Some(token)) => {
                Self::new_with_plaintext(url, token, local, config.inference_allow_plaintext)
                    .map(|m| Some(Arc::new(m)))
            }
            (None, None) => Ok(None),
            _ => anyhow::bail!("set both INFERENCE_URL and INFERENCE_TOKEN, or neither"),
        }
    }
    pub fn new(url: &str, token: &str, local: AppState) -> anyhow::Result<Self> {
        Self::new_with_plaintext(url, token, local, false)
    }
    fn new_with_plaintext(
        url: &str,
        token: &str,
        local: AppState,
        allow_plaintext: bool,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            local.remote_models.is_none(),
            "local fallback must not contain a remote adapter"
        );
        validate_url(url, allow_plaintext)?;
        anyhow::ensure!(
            token.chars().count() >= 32,
            "INFERENCE_TOKEN must contain at least 32 characters"
        );
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let side = std::env::var("EMBED_SIDE")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|s| *s >= 56 && *s <= 224 && s.is_multiple_of(14))
            .unwrap_or(112);
        Ok(Self {
            url: url.trim_end_matches('/').into(),
            token: token.into(),
            client,
            circuit: Mutex::new(Circuit::Closed(0)),
            runtime: tokio::runtime::Handle::current(),
            local,
            model: format!("dinov2-vits14-onnx@1/{side}"),
        })
    }
    fn ticket(&self) -> Result<Ticket, CallError> {
        let mut circuit = self.circuit.lock().unwrap_or_else(|e| e.into_inner());
        match *circuit {
            Circuit::Closed(generation) => Ok(Ticket { generation }),
            Circuit::Open { until, generation } if Instant::now() >= until => {
                *circuit = Circuit::HalfOpen(generation);
                Ok(Ticket { generation })
            }
            _ => Err(CallError::Unavailable("circuit_open")),
        }
    }
    fn finish(&self, ticket: Ticket, failed: bool) {
        let mut circuit = self.circuit.lock().unwrap_or_else(|e| e.into_inner());
        let generation = match *circuit {
            Circuit::Closed(g) | Circuit::HalfOpen(g) | Circuit::Open { generation: g, .. } => g,
        };
        // A late success from before an outage cannot close a newer open circuit.
        if ticket.generation != generation {
            return;
        }
        if failed {
            *circuit = Circuit::Open {
                until: Instant::now() + BREAKER_DELAY,
                generation: generation.wrapping_add(1),
            };
            tracing::warn!(
                backend = "local",
                reason = "worker_failure",
                "inference circuit opened for 30 seconds"
            );
        } else if matches!(*circuit, Circuit::HalfOpen(_)) {
            *circuit = Circuit::Closed(generation);
            tracing::info!(backend = "remote", "inference circuit recovered");
        }
    }
    fn attempt<T>(
        &self,
        operation: &str,
        work: impl FnOnce() -> Result<T, CallError>,
    ) -> Result<T, CallError> {
        if taphoa_recognition::work::current().is_some_and(|control| control.check().is_err()) {
            return Err(CallError::Unavailable("request_deadline"));
        }
        let ticket = self.ticket()?;
        let mut guard = AttemptGuard {
            remote: self,
            ticket: Some(ticket),
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let deadline = taphoa_recognition::work::current()
            .map_or(deadline, |control| deadline.min(control.deadline()));
        let _deadline = CallDeadline(CALL_DEADLINE.replace(Some(deadline)));
        let result = work();
        self.finish(
            guard.ticket.take().unwrap(),
            matches!(result, Err(CallError::Unavailable(_))),
        );
        if result.is_ok() {
            tracing::info!(backend = "remote", operation, "inference served");
        }
        result
    }
    async fn response<T: DeserializeOwned>(
        &self,
        response: Result<reqwest::Response, reqwest::Error>,
    ) -> Result<T, CallError> {
        let mut response = response.map_err(|e| {
            CallError::Unavailable(if e.is_timeout() {
                "worker_timeout"
            } else {
                "worker_transport"
            })
        })?;
        let status = response.status();
        if status.is_server_error() {
            return Err(CallError::Unavailable("worker_5xx"));
        }
        if status.is_client_error() {
            // Do not copy worker text or request/credential material to logs/errors.
            if status == reqwest::StatusCode::GONE {
                let mut bytes = Vec::new();
                while let Ok(Some(chunk)) = response.chunk().await {
                    if bytes.len() + chunk.len() > 4096 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if wire::decode::<ErrorResponse>(&bytes).is_ok_and(|e| e.code == "unknown_encoding")
                {
                    return Err(CallError::UnknownEncoding);
                }
            }
            return Err(CallError::Client(RemoteError {
                status: status.as_u16(),
                message: "inference worker rejected the request".into(),
            }));
        }
        if !status.is_success() {
            return Err(CallError::Unavailable("worker_protocol"));
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some(CONTENT_TYPE)
        {
            return Err(CallError::Unavailable("worker_protocol"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| CallError::Unavailable("worker_transport"))?
        {
            if bytes.len() + chunk.len() > BODY_LIMIT {
                return Err(CallError::Unavailable("worker_response_limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        wire::decode(&bytes).map_err(|_| CallError::Unavailable("worker_protocol"))
    }
    fn request<T: Serialize, R: DeserializeOwned>(
        &self,
        operation: &str,
        request: &T,
    ) -> Result<R, CallError> {
        let body = wire::encode(request).map_err(|_| RemoteError {
            status: 413,
            message: "inference request exceeds 10 MiB".into(),
        })?;
        let remaining = CALL_DEADLINE
            .get()
            .map_or(Duration::from_secs(10), |deadline| {
                deadline.saturating_duration_since(Instant::now())
            });
        if remaining.is_zero() {
            return Err(CallError::Unavailable("worker_timeout"));
        }
        self.runtime.block_on(async {
            self.response(
                self.client
                    .post(format!("{}/v1/{operation}", self.url))
                    .timeout(remaining)
                    .bearer_auth(&self.token)
                    .header(reqwest::header::CONTENT_TYPE, CONTENT_TYPE)
                    .body(body)
                    .send()
                    .await,
            )
            .await
        })
    }
    fn embeddings<T: Serialize>(
        &self,
        operation: &str,
        request: &T,
    ) -> Result<Vec<Vec<f32>>, CallError> {
        let response: EmbeddingResponse = self.request(operation, request)?;
        if response.model != self.model
            || response.dim != 384
            || response
                .vectors
                .iter()
                .any(|v| v.len() != 384 || v.iter().any(|x| !x.is_finite()))
        {
            return Err(CallError::Unavailable("worker_embedding_model"));
        }
        Ok(response.vectors)
    }
    fn single_embedding(&self, image: &[u8]) -> Result<Vec<f32>, CallError> {
        let mut vectors = self.embeddings(
            "embed",
            &ImageRequest {
                image: image.to_vec(),
            },
        )?;
        if vectors.len() != 1 {
            return Err(CallError::Unavailable("worker_embedding_shape"));
        }
        Ok(vectors.pop().unwrap())
    }
    fn image<R: DeserializeOwned>(&self, operation: &str, image: &[u8]) -> Result<R, CallError> {
        self.request(
            operation,
            &ImageRequest {
                image: image.to_vec(),
            },
        )
    }
    fn call<T, E: From<RemoteError>>(
        &self,
        operation: &str,
        remote: impl FnOnce() -> Result<T, CallError>,
        local: impl FnOnce(&AppState) -> Result<T, E>,
    ) -> Result<T, E> {
        match self.attempt(operation, remote) {
            Ok(value) => Ok(value),
            Err(CallError::Client(e)) => Err(e.into()),
            Err(CallError::UnknownEncoding) => Err(RemoteError {
                status: 410,
                message: "encoding could not be renewed".into(),
            }
            .into()),
            Err(CallError::Unavailable(reason)) => {
                tracing::info!(backend = "local", operation, reason, "inference fallback");
                if taphoa_recognition::work::current()
                    .is_some_and(|control| control.check().is_err())
                {
                    return Err(Self::unavailable().into());
                }
                local(&self.local)
            }
        }
    }
    fn local_lease<T>(
        &self,
        load: impl Future<Output = crate::ApiResult<T>>,
    ) -> crate::ApiResult<T> {
        let control = taphoa_recognition::work::current();
        self.runtime.block_on(async {
            let result = match control.as_ref() {
                Some(control) => tokio::time::timeout_at(control.deadline().into(), load)
                    .await
                    .map_err(|_| crate::busy())?,
                None => load.await,
            };
            // A ready loader may win the timer poll at the deadline. Never start
            // native fallback after expiry or cancellation of its request.
            if control.is_some_and(|control| control.check().is_err()) {
                return Err(crate::busy());
            }
            result
        })
    }
    pub fn local_state(&self) -> &AppState {
        &self.local
    }
    pub async fn healthy(&self) -> bool {
        let ticket = match self.ticket() {
            Ok(t) => t,
            Err(_) => return false,
        };
        let mut guard = AttemptGuard {
            remote: self,
            ticket: Some(ticket),
        };
        let response = self
            .client
            .get(format!("{}/healthz", self.url))
            .timeout(Duration::from_millis(500))
            .send()
            .await;
        let result = match response {
            Ok(response) => Self::health_response(response).await,
            Err(_) => false,
        };
        self.finish(guard.ticket.take().unwrap(), !result);
        result
    }
    async fn health_response(mut response: reqwest::Response) -> bool {
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > 4096) {
            return false;
        }
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if chunk.len() > 4096 - bytes.len() {
                        return false;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => return false,
            }
        }
        serde_json::from_slice::<Health>(&bytes).is_ok_and(|h| {
            h.status == "ready"
                && ["sam", "dinov2", "ocr"]
                    .iter()
                    .all(|f| h.loaded.iter().any(|x| x == f))
        })
    }
    fn unavailable() -> RemoteError {
        RemoteError {
            status: 503,
            message: "inference unavailable; retry shortly".into(),
        }
    }
}
pub fn api_error(error: RemoteError) -> ApiError {
    let status = axum::http::StatusCode::from_u16(error.status)
        .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
    let error = ApiError::new(
        status,
        if status.is_client_error() {
            "validation_failed"
        } else {
            "unavailable"
        },
        error.message,
    );
    if status == axum::http::StatusCode::SERVICE_UNAVAILABLE {
        error.with_retry_after(1)
    } else {
        error
    }
}
impl Segmenter for RemoteModels {
    fn segment(&self, image: &[u8]) -> Result<Vec<Segment>, SegmentError> {
        self.call(
            "segment",
            || self.image("segment", image),
            |local| {
                let model = self
                    .local_lease(local.model_segmenter())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                crate::inference::segment(&*model, image)
            },
        )
    }
}
impl Embedder for RemoteModels {
    fn model(&self) -> &str {
        &self.model
    }
    fn dim(&self) -> usize {
        384
    }
    fn embed(&self, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
        self.call(
            "embed",
            || self.single_embedding(image),
            |local| {
                let model = self
                    .local_lease(local.model_embedder())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                crate::inference::embed(&*model, image)
            },
        )
    }
    fn embed_crops_with_control(
        &self,
        crops: &[image::RgbImage],
        control: &taphoa_recognition::work::WorkControl,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        control.check()?;
        taphoa_recognition::work::scope(Some(control.clone()), || self.embed_crops(crops))
    }
    fn embed_crops(&self, crops: &[image::RgbImage]) -> Result<Vec<Vec<f32>>, EmbedError> {
        if crops.is_empty() {
            return Ok(Vec::new());
        }
        self.call(
            "embed-crops",
            || {
                let mut vectors = Vec::with_capacity(crops.len());
                let mut batch = Vec::new();
                let mut size = 8;
                for crop in crops {
                    let length = crop.as_raw().len() + 16;
                    if !batch.is_empty() && (size + length > BODY_LIMIT || batch.len() == 8) {
                        vectors.extend(self.embeddings(
                            "embed-crops",
                            &CropsRequest {
                                crops: std::mem::take(&mut batch),
                            },
                        )?);
                        size = 8;
                    }
                    if length + 8 > BODY_LIMIT {
                        if !batch.is_empty() {
                            vectors.extend(self.embeddings(
                                "embed-crops",
                                &CropsRequest {
                                    crops: std::mem::take(&mut batch),
                                },
                            )?);
                            size = 8;
                        }
                        let mut bytes = Vec::new();
                        crop.write_to(
                            &mut std::io::Cursor::new(&mut bytes),
                            image::ImageFormat::Png,
                        )
                        .map_err(|_| {
                            CallError::Client(RemoteError {
                                status: 400,
                                message: "invalid crop".into(),
                            })
                        })?;
                        vectors.push(self.single_embedding(&bytes)?);
                    } else {
                        batch.push(RgbCrop {
                            width: crop.width(),
                            height: crop.height(),
                            pixels: crop.as_raw().clone(),
                        });
                        size += length;
                    }
                }
                if !batch.is_empty() {
                    vectors.extend(self.embeddings("embed-crops", &CropsRequest { crops: batch })?);
                }
                if vectors.len() != crops.len()
                    || vectors
                        .iter()
                        .any(|v| v.len() != 384 || v.iter().any(|x| !x.is_finite()))
                {
                    return Err(CallError::Unavailable("worker_embedding_shape"));
                }
                Ok(vectors)
            },
            |local| {
                let model = self
                    .local_lease(local.model_embedder())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                crate::inference::embed_crops(&*model, crops)
            },
        )
    }
}
impl PointSegmenter for RemoteModels {
    fn encode(&self, image: &[u8]) -> Result<Arc<ImageEncoding>, SegmentError> {
        let source: Arc<[u8]> = image.into();
        self.call(
            "encode",
            || {
                let response: EncodingResponse = self.image("encode", image)?;
                Ok(Arc::new(ImageEncoding::external(
                    response.width,
                    response.height,
                    Arc::new(RemoteEncoding {
                        image: source.clone(),
                        handle: Mutex::new(Some(response.handle)),
                        local: Mutex::new(None),
                    }),
                )))
            },
            |local| {
                let model = self
                    .local_lease(local.model_point_segmenter())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                let encoding = model.encode(image)?;
                Ok(Arc::new(ImageEncoding::external(
                    encoding.width,
                    encoding.height,
                    Arc::new(RemoteEncoding {
                        image: source.clone(),
                        handle: Mutex::new(None),
                        local: Mutex::new(Some(encoding)),
                    }),
                )))
            },
        )
    }
    fn decode_points(
        &self,
        encoding: &ImageEncoding,
        points: &[PointPrompt],
    ) -> Result<PointSegment, SegmentError> {
        taphoa_recognition::validate_points(points, encoding.width, encoding.height)?;
        let state = encoding.external_state::<RemoteEncoding>();
        self.call(
            "decode-points",
            || {
                let state = state.ok_or(CallError::Unavailable("local_encoding"))?;
                let mut handle = state.handle.lock().unwrap_or_else(|e| e.into_inner());
                if handle.is_none() {
                    let response: EncodingResponse = self.image("encode", &state.image)?;
                    *handle = Some(response.handle);
                }
                let request = PointsRequest {
                    handle: handle.clone().unwrap(),
                    points: points.to_vec(),
                };
                let response: PointResponse = match self.request("decode-points", &request) {
                    Err(CallError::UnknownEncoding) => {
                        let response: EncodingResponse = self.image("encode", &state.image)?;
                        *handle = Some(response.handle.clone());
                        self.request(
                            "decode-points",
                            &PointsRequest {
                                handle: response.handle,
                                points: points.to_vec(),
                            },
                        )?
                    }
                    result => result?,
                };
                response
                    .into_segment()
                    .map_err(|_| CallError::Unavailable("worker_mask_shape"))
            },
            |local| {
                let model = self
                    .local_lease(local.model_point_segmenter())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                match state {
                    Some(state) => {
                        let mut cached = state.local.lock().unwrap_or_else(|e| e.into_inner());
                        if cached.is_none() {
                            *cached = Some(model.encode(&state.image)?);
                        }
                        model.decode_points(cached.as_ref().unwrap(), points)
                    }
                    None => model.decode_points(encoding, points),
                }
            },
        )
    }
}
impl TextDetector for RemoteModels {
    fn detect(&self, image: &[u8]) -> Result<Vec<TextBox>, OcrError> {
        self.call(
            "detect-text",
            || self.image("detect-text", image),
            |local| {
                let model = self
                    .local_lease(local.model_text_detector())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                model.detect(image)
            },
        )
    }
    fn document_signal(&self, image: &[u8]) -> Result<DocumentSignal, OcrError> {
        self.call(
            "document-signal",
            || self.image("document-signal", image),
            |local| {
                let model = self
                    .local_lease(local.model_text_detector())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                model.document_signal(image)
            },
        )
    }
}
impl ReceiptOcr for RemoteModels {
    fn read_lines(&self, image: &[u8]) -> Result<Vec<OcrLine>, OcrError> {
        self.call(
            "read-lines",
            || self.image("read-lines", image),
            |local| {
                let model = self
                    .local_lease(local.model_receipt_ocr())
                    .map_err(|_| Self::unavailable())?
                    .ok_or_else(Self::unavailable)?;
                let control = taphoa_recognition::work::current();
                let mut options = taphoa_recognition::ocr::ReceiptOptions::bounded();
                options.control = control.as_ref();
                model.read_lines_with_options(image, Some(&options))
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::State,
        http::{StatusCode, header},
        response::IntoResponse,
        routing::{get, post},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use taphoa_recognition::{
        MockEmbedder, MockPointSegmenter,
        ocr::{FakeReceiptOcr, FakeTextDetector},
    };
    const TOKEN: &str = "a-unit-test-token-at-least-32-characters";
    struct Local(Arc<AtomicUsize>);
    impl Segmenter for Local {
        fn segment(&self, _: &[u8]) -> Result<Vec<Segment>, SegmentError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(vec![])
        }
    }
    #[derive(Clone)]
    struct Fake {
        status: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
        encodes: Arc<AtomicUsize>,
        decodes: Arc<AtomicUsize>,
    }
    async fn fake_segment(State(state): State<Fake>) -> axum::response::Response {
        state.calls.fetch_add(1, Ordering::SeqCst);
        (
            StatusCode::from_u16(state.status.load(Ordering::SeqCst) as u16).unwrap(),
            [(header::CONTENT_TYPE, CONTENT_TYPE)],
            wire::encode(&Vec::<Segment>::new()).unwrap(),
        )
            .into_response()
    }
    async fn fake_health(State(state): State<Fake>) -> axum::response::Response {
        (
            StatusCode::from_u16(state.status.load(Ordering::SeqCst) as u16).unwrap(),
            axum::Json(Health {
                status: "ready".into(),
                provider: "cpu".into(),
                loaded: vec!["sam".into(), "dinov2".into(), "ocr".into()],
                version: "test".into(),
            }),
        )
            .into_response()
    }
    async fn fake_encode(State(state): State<Fake>) -> axum::response::Response {
        let id = state.encodes.fetch_add(1, Ordering::SeqCst);
        (
            [(header::CONTENT_TYPE, CONTENT_TYPE)],
            wire::encode(&EncodingResponse {
                handle: id.to_string(),
                width: 2,
                height: 2,
            })
            .unwrap(),
        )
            .into_response()
    }
    async fn fake_decode(State(state): State<Fake>, bytes: Bytes) -> axum::response::Response {
        let _: PointsRequest = wire::decode(&bytes).unwrap();
        if state.decodes.fetch_add(1, Ordering::SeqCst) == 0 {
            return (
                StatusCode::GONE,
                [(header::CONTENT_TYPE, CONTENT_TYPE)],
                wire::encode(&ErrorResponse {
                    code: "unknown_encoding".into(),
                    message: "gone".into(),
                })
                .unwrap(),
            )
                .into_response();
        }
        (
            [(header::CONTENT_TYPE, CONTENT_TYPE)],
            wire::encode(&PointResponse {
                segment: Segment {
                    bbox: [0., 0., 2., 2.],
                    score: 1.,
                    area: 4,
                },
                width: 2,
                height: 2,
                mask: vec![15],
            })
            .unwrap(),
        )
            .into_response()
    }
    async fn worker() -> (String, Fake, tokio::task::JoinHandle<()>) {
        let fake = Fake {
            status: Arc::new(AtomicUsize::new(200)),
            calls: Arc::new(AtomicUsize::new(0)),
            encodes: Arc::new(AtomicUsize::new(0)),
            decodes: Arc::new(AtomicUsize::new(0)),
        };
        let router = Router::new()
            .route("/v1/segment", post(fake_segment))
            .route("/v1/encode", post(fake_encode))
            .route("/v1/decode-points", post(fake_decode))
            .route("/healthz", get(fake_health))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (url, fake, task)
    }
    fn local() -> (AppState, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            AppState {
                segmenter: Some(Arc::new(Local(calls.clone()))),
                point_segmenter: Some(Arc::new(MockPointSegmenter::default())),
                embedder: Some(Arc::new(MockEmbedder)),
                receipt_ocr: Some(Arc::new(FakeReceiptOcr::default())),
                text_detector: Some(Arc::new(FakeTextDetector::default())),
                ..AppState::default()
            },
            calls,
        )
    }
    async fn segment(remote: Arc<RemoteModels>) -> Result<Vec<Segment>, SegmentError> {
        tokio::task::spawn_blocking(move || remote.segment(&[1]))
            .await
            .unwrap()
    }
    fn expire(remote: &RemoteModels) {
        let mut state = remote.circuit.lock().unwrap();
        let generation = match *state {
            Circuit::Open { generation, .. } => generation,
            _ => panic!("must be open"),
        };
        *state = Circuit::Open {
            generation,
            until: Instant::now() - Duration::from_secs(1),
        };
    }
    #[tokio::test]
    async fn success_5xx_breaker_single_probe_and_recovery() {
        let (url, fake, task) = worker().await;
        let (local, local_calls) = local();
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, local).unwrap());
        segment(remote.clone()).await.unwrap();
        assert_eq!(local_calls.load(Ordering::SeqCst), 0);
        fake.status.store(503, Ordering::SeqCst);
        segment(remote.clone()).await.unwrap();
        segment(remote.clone()).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        assert_eq!(local_calls.load(Ordering::SeqCst), 2);
        expire(&remote);
        let ticket = remote.ticket().unwrap();
        assert!(remote.ticket().is_err());
        remote.finish(ticket, true);
        expire(&remote);
        fake.status.store(200, Ordering::SeqCst);
        segment(remote.clone()).await.unwrap();
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Closed(_)
        ));
        assert_eq!(local_calls.load(Ordering::SeqCst), 2);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 3);
        task.abort();
    }
    #[tokio::test]
    async fn transport_failure_uses_local_once_and_missing_local_is_retryable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (local, calls) = local();
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, local).unwrap());
        segment(remote.clone()).await.unwrap();
        segment(remote.clone()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Open { .. }
        ));
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, AppState::default()).unwrap());
        let error = segment(remote).await.unwrap_err();
        assert!(matches!(
            error,
            SegmentError::Remote(RemoteError { status: 503, .. })
        ));
    }
    #[tokio::test]
    async fn client_error_is_returned_with_no_fallback_or_breaker() {
        let (url, fake, task) = worker().await;
        fake.status.store(422, Ordering::SeqCst);
        let (local, calls) = local();
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, local).unwrap());
        let error = segment(remote.clone()).await.unwrap_err();
        assert!(matches!(
            error,
            SegmentError::Remote(RemoteError { status: 422, .. })
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Closed(_)
        ));
        task.abort();
    }
    #[tokio::test]
    async fn unknown_handle_reencodes_once_and_updates_cached_handle() {
        let (url, fake, task) = worker().await;
        let (local, _) = local();
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, local).unwrap());
        tokio::task::spawn_blocking(move || {
            let encoding = remote.encode(&[1]).unwrap();
            let points = [PointPrompt {
                x: 1.,
                y: 1.,
                label: 1,
            }];
            assert_eq!(
                remote
                    .decode_points(&encoding, &points)
                    .unwrap()
                    .mask
                    .as_raw(),
                &[255; 4]
            );
            remote.decode_points(&encoding, &points).unwrap();
        })
        .await
        .unwrap();
        assert_eq!(fake.encodes.load(Ordering::SeqCst), 2);
        assert_eq!(fake.decodes.load(Ordering::SeqCst), 3);
        task.abort();
    }
    #[tokio::test]
    async fn warm_uses_health_without_local_load_and_loads_local_when_down() {
        let (url, fake, task) = worker().await;
        let (mut local, _) = local();
        local.embedder = None;
        let loads = Arc::new(AtomicUsize::new(0));
        let count = loads.clone();
        local.models.dino = Some(crate::model_holder::ModelHolder::new(
            "dinov2",
            Duration::ZERO,
            move || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(Arc::new(MockEmbedder) as Arc<dyn Embedder>)
            },
        ));
        let mut state = local.clone();
        state.remote_models = Some(Arc::new(RemoteModels::new(&url, TOKEN, local).unwrap()));
        let warm = crate::recognition::warm::warm_models(&state).await.unwrap();
        assert_eq!(
            serde_json::to_value(warm).unwrap()["sam"]["backend"],
            "remote"
        );
        assert_eq!(loads.load(Ordering::SeqCst), 0);
        fake.status.store(503, Ordering::SeqCst);
        let warm = crate::recognition::warm::warm_models(&state).await.unwrap();
        assert_eq!(
            serde_json::to_value(warm).unwrap()["dinov2"]["backend"],
            "local"
        );
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        task.abort();
    }
    #[tokio::test]
    async fn cancelled_load_result_is_not_used_for_local_inference() {
        let remote = RemoteModels::new("http://127.0.0.1:1", TOKEN, AppState::default()).unwrap();
        let error = tokio::task::spawn_blocking(move || {
            let control =
                taphoa_recognition::work::WorkControl::new(Instant::now() + Duration::from_secs(1));
            taphoa_recognition::work::scope(Some(control.clone()), || {
                remote
                    .local_lease(async {
                        control.cancel();
                        Ok(42)
                    })
                    .unwrap_err()
            })
        })
        .await
        .unwrap();
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
    }
    #[tokio::test]
    async fn stale_success_cannot_close_a_newer_open_circuit() {
        let (url, _, task) = worker().await;
        let (local, _) = local();
        let remote = RemoteModels::new(&url, TOKEN, local).unwrap();
        let old = remote.ticket().unwrap();
        let failed = remote.ticket().unwrap();
        remote.finish(failed, true);
        remote.finish(old, false);
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Open { .. }
        ));
        task.abort();
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        routing::get,
    };
    use futures_util::StreamExt;
    #[test]
    fn inference_transport_matrix_requires_encryption_unless_explicitly_overridden() {
        for url in [
            "http://127.0.0.1:8090",
            "http://127.12.3.4",
            "http://localhost",
            "http://LOCALHOST.",
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "https://inference.example",
            "https://192.168.1.20",
        ] {
            assert!(validate_url(url, false).is_ok(), "{url}");
        }
        for url in [
            "http://example.com",
            "http://192.168.1.20",
            "http://10.0.0.2",
            "http://[::]",
            "http://0.0.0.0",
            "http://127.0.0.1.evil",
            "http://worker.localhost",
        ] {
            assert!(
                validate_url(url, false)
                    .unwrap_err()
                    .to_string()
                    .contains("INFERENCE_ALLOW_PLAINTEXT=1"),
                "{url}"
            );
            assert!(validate_url(url, true).is_ok(), "{url}");
        }
        for url in [
            "ftp://example.com",
            "https://user:secret@example.com",
            "http://localhost?token=secret",
            "http://localhost#fragment",
        ] {
            assert!(validate_url(url, false).is_err());
            assert!(validate_url(url, true).is_err());
        }
        let config = |value: &str| {
            crate::config::Config::from_lookup(|name| match name {
                "CLERK_ISSUER" => Some("https://local.clerk.accounts.dev".into()),
                "INFERENCE_URL" => Some("http://192.168.1.20".into()),
                "INFERENCE_TOKEN" => Some("a-test-token-that-is-at-least-32-characters".into()),
                "INFERENCE_ALLOW_PLAINTEXT" => Some(value.into()),
                _ => None,
            })
        };
        assert!(config("0").is_err());
        assert!(config("true").is_err());
        assert!(config("1").unwrap().inference_allow_plaintext);
    }
    #[tokio::test]
    async fn oversized_chunked_health_is_stopped_before_body_completion() {
        let app = Router::new().route(
            "/healthz",
            get(|| async {
                let chunks = futures_util::stream::iter(
                    (0..16).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 1024]))),
                );
                // Never completes: bytes() would wait until the 500 ms timeout.
                Body::from_stream(chunks.chain(futures_util::stream::pending()))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let remote = RemoteModels::new(
            &url,
            "health-test-token-with-at-least-32-characters",
            AppState::default(),
        )
        .unwrap();
        let response = remote
            .client
            .get(format!("{url}/healthz"))
            .send()
            .await
            .unwrap();
        assert!(response.content_length().is_none());
        drop(response);
        assert!(
            !tokio::time::timeout(Duration::from_millis(250), remote.healthy())
                .await
                .expect("must stop at 4 KiB without waiting for the full body")
        );
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Open { .. }
        ));
        server.abort();
    }
}

#[cfg(test)]
mod ocr_limit_tests {
    use super::*;
    use axum::{
        Router,
        http::{StatusCode, header},
        routing::post,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Local(Arc<AtomicUsize>);
    impl ReceiptOcr for Local {
        fn read_lines(&self, _: &[u8]) -> Result<Vec<OcrLine>, OcrError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
    }
    #[tokio::test]
    async fn worker_ocr_work_limit_is_a_client_error_and_never_falls_back() {
        let router = Router::new().route(
            "/v1/read-lines",
            post(|| async {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    [(header::CONTENT_TYPE, CONTENT_TYPE)],
                    wire::encode(&ErrorResponse {
                        code: "ocr_work_limit".into(),
                        message: "too many text boxes".into(),
                    })
                    .unwrap(),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let local = AppState {
            receipt_ocr: Some(Arc::new(Local(calls.clone()))),
            ..AppState::default()
        };
        let remote = Arc::new(
            RemoteModels::new(&url, "receipt-test-token-at-least-32-characters", local).unwrap(),
        );
        let copy = remote.clone();
        let error = tokio::task::spawn_blocking(move || copy.read_lines(&[0]))
            .await
            .unwrap()
            .unwrap_err();
        let OcrError::Remote(error) = error else {
            panic!("expected client error")
        };
        assert_eq!(api_error(error).status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Closed(_)
        ));
        task.abort();
    }
}
