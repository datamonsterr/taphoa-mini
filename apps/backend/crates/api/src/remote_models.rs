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

const HEALTH_INTERVAL: Duration = Duration::from_secs(15);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
#[derive(Debug)]
enum Circuit {
    Closed(u64),
    Open { generation: u64 },
}
impl Circuit {
    fn generation(&self) -> u64 {
        match *self {
            Self::Closed(g) | Self::Open { generation: g } => g,
        }
    }
}
struct Ticket {
    generation: u64,
}
#[derive(Clone, Copy)]
struct FailureReason {
    reason: &'static str,
    status: Option<u16>,
}
impl FailureReason {
    fn new(reason: &'static str) -> Self {
        Self {
            reason,
            status: None,
        }
    }
    fn transport(error: &reqwest::Error) -> Self {
        Self::new(if error.is_timeout() {
            "worker_timeout"
        } else if error.is_connect() {
            "worker_connect"
        } else {
            "worker_transport"
        })
    }
    fn http(status: u16) -> Self {
        Self {
            reason: "worker_http_status",
            status: Some(status),
        }
    }
}
#[derive(Debug)]
enum CallError {
    Unavailable(&'static str),
    Client(RemoteError),
    UnknownEncoding,
    HttpStatus(u16),
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
    side: u32,
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
        let client = Self::client_builder().build()?;
        let side = std::env::var("EMBED_SIDE")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|s| *s >= 56 && *s <= 224 && s.is_multiple_of(14))
            .unwrap_or(112);
        Ok(Self {
            url: url.trim_end_matches('/').into(),
            token: token.into(),
            client,
            circuit: Mutex::new(Circuit::Open { generation: 0 }),
            runtime: tokio::runtime::Handle::current(),
            local,
            model: format!("dinov2-vits14-onnx@1/{side}"),
            side,
        })
    }
    fn client_builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .http1_only()
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(1)
            .tcp_keepalive(Duration::from_secs(30))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
    }
    fn ticket(&self) -> Result<Ticket, CallError> {
        match *self.circuit.lock().unwrap_or_else(|e| e.into_inner()) {
            Circuit::Closed(generation) => Ok(Ticket { generation }),
            Circuit::Open { .. } => Err(CallError::Unavailable("circuit_open")),
        }
    }
    fn finish(&self, ticket: Ticket, failure: Option<FailureReason>) {
        if let Some(failure) = failure {
            self.set_health(ticket.generation, Err(failure));
        }
    }
    fn set_health(&self, generation: u64, result: Result<(), FailureReason>) {
        let mut circuit = self.circuit.lock().unwrap_or_else(|e| e.into_inner());
        // Neither a late health success nor a late request failure can overwrite
        // a newer observation. User successes never close the circuit.
        if circuit.generation() != generation {
            return;
        }
        match result {
            Err(failure) => {
                let changed = matches!(*circuit, Circuit::Closed(_));
                *circuit = Circuit::Open {
                    generation: generation.wrapping_add(1),
                };
                if changed {
                    tracing::info!(
                        state = "open",
                        reason = failure.reason,
                        status = failure.status,
                        "inference circuit changed"
                    );
                }
            }
            Ok(()) => {
                let changed = matches!(*circuit, Circuit::Open { .. });
                if changed {
                    *circuit = Circuit::Closed(generation.wrapping_add(1));
                    tracing::info!(
                        state = "closed",
                        reason = "worker_healthy",
                        "inference circuit changed"
                    );
                }
            }
        }
    }
    fn attempt<T>(&self, work: impl FnOnce() -> Result<T, CallError>) -> Result<T, CallError> {
        if taphoa_recognition::work::current().is_some_and(|control| control.check().is_err()) {
            return Err(CallError::Unavailable("request_deadline"));
        }
        let ticket = self.ticket()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let deadline = taphoa_recognition::work::current()
            .map_or(deadline, |control| deadline.min(control.deadline()));
        let _deadline = CallDeadline(CALL_DEADLINE.replace(Some(deadline)));
        let result = work();
        self.finish(
            ticket,
            match &result {
                Err(CallError::Unavailable(reason)) => Some(FailureReason::new(reason)),
                Err(CallError::HttpStatus(status)) => Some(FailureReason::http(*status)),
                _ => None,
            },
        );
        result
    }
    async fn response<T: DeserializeOwned>(
        &self,
        response: Result<reqwest::Response, reqwest::Error>,
    ) -> Result<T, CallError> {
        let mut response =
            response.map_err(|e| CallError::Unavailable(FailureReason::transport(&e).reason))?;
        let status = response.status();
        if status.is_server_error() {
            return Err(CallError::HttpStatus(status.as_u16()));
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
            return Err(CallError::HttpStatus(status.as_u16()));
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
            .map_err(|e| CallError::Unavailable(FailureReason::transport(&e).reason))?
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
        let started = Instant::now();
        let result = self.runtime.block_on(async {
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
        });
        Self::log_call(operation, started, &result);
        result
    }
    fn log_call<T>(operation: &str, started: Instant, result: &Result<T, CallError>) {
        let (outcome, status) = match result {
            Ok(_) => ("success", None),
            Err(CallError::Unavailable(reason)) => (*reason, None),
            Err(CallError::HttpStatus(status)) => ("worker_http_status", Some(*status)),
            Err(CallError::Client(error)) => ("worker_client_error", Some(error.status)),
            Err(CallError::UnknownEncoding) => ("unknown_encoding", Some(410)),
        };
        tracing::debug!(
            operation,
            duration_ms = started.elapsed().as_millis() as u64,
            outcome,
            status,
            "inference remote call"
        );
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
        let result = self.attempt(remote).map_err(|error| match error {
            CallError::HttpStatus(_) => CallError::Unavailable("worker_http_status"),
            error => error,
        });
        match result {
            Ok(value) => Ok(value),
            Err(CallError::Client(e)) => Err(e.into()),
            Err(CallError::HttpStatus(_)) => unreachable!("HTTP failure normalized above"),
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
    /// Read the monitor's state without doing network I/O on a user request.
    pub fn healthy(&self) -> bool {
        matches!(
            *self.circuit.lock().unwrap_or_else(|e| e.into_inner()),
            Circuit::Closed(_)
        )
    }
    pub fn spawn_monitor(
        self: &Arc<Self>,
        shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        self.spawn_monitor_with_interval(shutdown, HEALTH_INTERVAL)
    }
    fn spawn_monitor_with_interval(
        self: &Arc<Self>,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
        period: Duration,
    ) -> tokio::task::JoinHandle<()> {
        let remote = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                if *shutdown.borrow_and_update() {
                    break;
                }
                tokio::select! {
                    biased;
                    changed = shutdown.changed() => { if changed.is_err() { break; } continue; },
                    _ = interval.tick() => {}
                }
                let generation = remote
                    .circuit
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .generation();
                let result = tokio::select! {
                    biased;
                    changed = shutdown.changed() => { if changed.is_err() { break; } continue; },
                    result = remote.probe_health() => result,
                };
                remote.set_health(generation, result);
                if shutdown.has_changed().is_err() {
                    break;
                }
            }
        })
    }
    async fn probe_health(&self) -> Result<(), FailureReason> {
        let started = Instant::now();
        let result = async {
            let response = self
                .client
                .get(format!("{}/healthz", self.url))
                .timeout(HEALTH_TIMEOUT)
                .send()
                .await
                .map_err(|e| FailureReason::transport(&e))?;
            Self::health_response(response).await
        }
        .await;
        let logged = result.map_err(|failure| match failure.status {
            Some(status) => CallError::HttpStatus(status),
            None => CallError::Unavailable(failure.reason),
        });
        Self::log_call("health", started, &logged);
        result
    }
    async fn health_response(mut response: reqwest::Response) -> Result<(), FailureReason> {
        if !response.status().is_success() {
            return Err(FailureReason::http(response.status().as_u16()));
        }
        if response.content_length().is_some_and(|n| n > 4096) {
            return Err(FailureReason::new("worker_response_limit"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| FailureReason::transport(&e))?
        {
            if chunk.len() > 4096 - bytes.len() {
                return Err(FailureReason::new("worker_response_limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if serde_json::from_slice::<Health>(&bytes).is_ok_and(|h| {
            h.status == "ready"
                && ["sam", "dinov2", "ocr"]
                    .iter()
                    .all(|f| h.loaded.iter().any(|x| x == f))
        }) {
            Ok(())
        } else {
            Err(FailureReason::new("worker_not_ready"))
        }
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
/// The worker accepts at most 64 crops per `/v1/embed-crops` request. Keep the request body
/// at or below 4 MiB (the wire limit is 10 MiB): 64 crops at the default side of 112, 27 at
/// the maximum side of 224. The worker runs one inference at a time and queues three
/// requests, so sending chunks in parallel would only occupy its queue; fewer, larger
/// requests save network round trips instead.
const MAX_CROPS_PER_REQUEST: usize = 64;
const CROP_REQUEST_BUDGET: usize = 4 * 1024 * 1024;
fn crops_per_request(side: u32) -> usize {
    let crop_bytes = (side as usize).pow(2) * 3 + 16;
    (CROP_REQUEST_BUDGET / crop_bytes).clamp(1, MAX_CROPS_PER_REQUEST)
}
fn embedding_request(crops: &[image::RgbImage], side: u32) -> CropsRequest {
    CropsRequest {
        crops: crops
            .iter()
            .map(|crop| {
                let resized = taphoa_recognition::crop::resize_for_embedding(crop, side);
                RgbCrop {
                    width: side,
                    height: side,
                    pixels: resized.as_raw().clone(),
                }
            })
            .collect(),
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
                // Resize before transport with the very same local tensor preprocessing.
                // Each request is a sequential worker round trip, so use as few as the
                // worker limits allow (see `crops_per_request`).
                for batch in crops.chunks(crops_per_request(self.side)) {
                    vectors.extend(
                        self.embeddings("embed-crops", &embedding_request(batch, self.side))?,
                    );
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
pub(crate) fn ready_remote(
    url: &str,
    token: &str,
    local: AppState,
) -> anyhow::Result<RemoteModels> {
    let remote = RemoteModels::new(url, token, local)?;
    *remote.circuit.lock().unwrap() = Circuit::Closed(0);
    Ok(remote)
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
        health_calls: Arc<AtomicUsize>,
        health_hangs: Arc<std::sync::atomic::AtomicBool>,
        peers: Arc<Mutex<std::collections::HashSet<std::net::SocketAddr>>>,
    }
    async fn fake_segment(
        State(state): State<Fake>,
        axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    ) -> axum::response::Response {
        state.peers.lock().unwrap().insert(peer);
        state.calls.fetch_add(1, Ordering::SeqCst);
        (
            StatusCode::from_u16(state.status.load(Ordering::SeqCst) as u16).unwrap(),
            [(header::CONTENT_TYPE, CONTENT_TYPE)],
            wire::encode(&Vec::<Segment>::new()).unwrap(),
        )
            .into_response()
    }
    async fn fake_health(
        State(state): State<Fake>,
        axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    ) -> axum::response::Response {
        state.peers.lock().unwrap().insert(peer);
        state.health_calls.fetch_add(1, Ordering::SeqCst);
        if state.health_hangs.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
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
            health_calls: Arc::new(AtomicUsize::new(0)),
            health_hangs: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            peers: Arc::new(Mutex::new(std::collections::HashSet::new())),
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
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
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
    #[tokio::test]
    async fn success_5xx_breaker_stays_open_until_health_recovery() {
        let (url, fake, task) = worker().await;
        let (local, local_calls) = local();
        let remote = Arc::new(ready_remote(&url, TOKEN, local).unwrap());
        segment(remote.clone()).await.unwrap();
        fake.status.store(503, Ordering::SeqCst);
        segment(remote.clone()).await.unwrap();
        segment(remote.clone()).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        assert_eq!(local_calls.load(Ordering::SeqCst), 2);
        assert!(remote.ticket().is_err());
        let generation = remote.circuit.lock().unwrap().generation();
        fake.status.store(200, Ordering::SeqCst);
        remote.set_health(generation, remote.probe_health().await);
        segment(remote.clone()).await.unwrap();
        assert!(remote.healthy());
        assert_eq!(local_calls.load(Ordering::SeqCst), 2);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 3);
        task.abort();
    }
    #[tokio::test]
    async fn fresh_tls_connection_survives_800ms_delayed_accept() {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // Public, test-only certificate/key; no runtime key generation.
        let certificate = include_bytes!("../tests/fixtures/remote-tls/cert.pem");
        let key = include_bytes!("../tests/fixtures/remote-tls/key.pem");
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from_pem_slice(certificate).unwrap()],
                PrivateKeyDer::from_pem_slice(key).unwrap(),
            )
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("https://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_rustls::TlsAcceptor::from(Arc::new(tls))
                .accept(socket)
                .await
                .unwrap();
            let mut head = Vec::new();
            loop {
                head.push(socket.read_u8().await.unwrap());
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8(head).unwrap();
            assert!(head.starts_with("POST /v1/segment HTTP/1.1"));
            let size: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            socket.read_exact(&mut vec![0; size]).await.unwrap();
            let body = wire::encode(&Vec::<Segment>::new()).unwrap();
            socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: {CONTENT_TYPE}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let (local, local_calls) = local();
        let mut remote = ready_remote(&url, TOKEN, local).unwrap();
        remote.client = RemoteModels::client_builder()
            .add_root_certificate(reqwest::Certificate::from_pem(certificate).unwrap())
            .build()
            .unwrap();
        let started = Instant::now();
        segment(Arc::new(remote)).await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(800));
        assert_eq!(local_calls.load(Ordering::SeqCst), 0);
        task.await.unwrap();
    }
    async fn wait_health(remote: &RemoteModels, healthy: bool) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while remote.healthy() != healthy {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("monitor must update breaker");
    }
    #[tokio::test]
    async fn background_monitor_opens_recovers_and_open_calls_never_contact_worker() {
        let (url, fake, task) = worker().await;
        let (local, local_calls) = local();
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, local).unwrap());
        assert!(!remote.healthy());
        segment(remote.clone()).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let monitor = remote.spawn_monitor_with_interval(stopped, Duration::from_millis(50));
        wait_health(&remote, true).await;
        segment(remote.clone()).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        fake.health_hangs.store(true, Ordering::SeqCst);
        wait_health(&remote, false).await;
        let reached = fake.calls.swap(0, Ordering::SeqCst);
        assert_eq!(reached, 1);
        for _ in 0..3 {
            segment(remote.clone()).await.unwrap();
        }
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        assert_eq!(local_calls.load(Ordering::SeqCst), 4);
        fake.health_hangs.store(false, Ordering::SeqCst);
        wait_health(&remote, true).await;
        segment(remote.clone()).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        stop.send_replace(true);
        tokio::time::timeout(Duration::from_millis(250), monitor)
            .await
            .unwrap()
            .unwrap();
        task.abort();
    }
    #[tokio::test]
    async fn health_connection_is_reused_for_inference() {
        let (url, fake, task) = worker().await;
        let (local, _) = local();
        let remote = Arc::new(ready_remote(&url, TOKEN, local).unwrap());
        assert!(remote.probe_health().await.is_ok());
        segment(remote.clone()).await.unwrap();
        assert!(remote.probe_health().await.is_ok());
        assert_eq!(fake.health_calls.load(Ordering::SeqCst), 2);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            fake.peers.lock().unwrap().len(),
            1,
            "health and inference share one HTTP/1 connection"
        );
        task.abort();
    }
    #[tokio::test]
    async fn healthy_monitor_tick_does_not_discard_inflight_user_failure() {
        let remote = ready_remote("http://127.0.0.1:1", TOKEN, AppState::default()).unwrap();
        let ticket = remote.ticket().unwrap();
        remote.set_health(ticket.generation, Ok(()));
        remote.finish(ticket, Some(FailureReason::new("worker_connect")));
        assert!(!remote.healthy());
    }
    #[tokio::test]
    async fn monitor_shutdown_cancels_inflight_health() {
        let (url, fake, task) = worker().await;
        fake.health_hangs.store(true, Ordering::SeqCst);
        let remote = Arc::new(RemoteModels::new(&url, TOKEN, AppState::default()).unwrap());
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let monitor = remote.spawn_monitor(stopped);
        while fake.health_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        stop.send_replace(true);
        tokio::time::timeout(Duration::from_millis(250), monitor)
            .await
            .unwrap()
            .unwrap();
        task.abort();
    }
    #[tokio::test]
    async fn stale_health_success_cannot_close_newer_request_failure() {
        let remote = ready_remote("http://127.0.0.1:1", TOKEN, AppState::default()).unwrap();
        let generation = remote.circuit.lock().unwrap().generation();
        remote.finish(
            remote.ticket().unwrap(),
            Some(FailureReason::new("worker_connect")),
        );
        remote.set_health(generation, Ok(()));
        assert!(!remote.healthy());
    }
    #[tokio::test]
    async fn transport_failure_uses_local_once_and_missing_local_is_retryable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (local, calls) = local();
        let remote = Arc::new(ready_remote(&url, TOKEN, local).unwrap());
        segment(remote.clone()).await.unwrap();
        segment(remote.clone()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(matches!(
            *remote.circuit.lock().unwrap(),
            Circuit::Open { .. }
        ));
        let remote = Arc::new(ready_remote(&url, TOKEN, AppState::default()).unwrap());
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
        let remote = Arc::new(ready_remote(&url, TOKEN, local).unwrap());
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
        let remote = Arc::new(ready_remote(&url, TOKEN, local).unwrap());
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
    async fn warm_reads_breaker_without_health_call_and_loads_local_when_down() {
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
        state.remote_models = Some(Arc::new(ready_remote(&url, TOKEN, local).unwrap()));
        let warm = crate::recognition::warm::warm_models(&state).await.unwrap();
        assert_eq!(
            serde_json::to_value(warm).unwrap()["sam"]["backend"],
            "remote"
        );
        assert_eq!(loads.load(Ordering::SeqCst), 0);
        assert_eq!(fake.health_calls.load(Ordering::SeqCst), 0);
        fake.status.store(503, Ordering::SeqCst);
        let remote = state.remote_models.as_ref().unwrap();
        let generation = remote.circuit.lock().unwrap().generation();
        remote.set_health(generation, remote.probe_health().await);
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
        let remote = ready_remote("http://127.0.0.1:1", TOKEN, AppState::default()).unwrap();
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
        let remote = ready_remote(&url, TOKEN, local).unwrap();
        let old = remote.ticket().unwrap();
        let failed = remote.ticket().unwrap();
        remote.finish(failed, Some(FailureReason::new("worker_timeout")));
        remote.finish(old, None);
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
                // Never completes: bytes() would wait until the 2 s timeout.
                Body::from_stream(chunks.chain(futures_util::stream::pending()))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let remote = ready_remote(
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
            tokio::time::timeout(Duration::from_millis(250), remote.probe_health())
                .await
                .expect("must stop at 4 KiB without waiting for the full body")
                .is_err()
        );
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
            ready_remote(&url, "receipt-test-token-at-least-32-characters", local).unwrap(),
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

#[cfg(test)]
mod crop_transport_tests {
    use super::*;
    #[test]
    fn remote_crop_tensors_match_local_exactly_at_every_side() {
        let crop = image::RgbImage::from_fn(371, 193, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        for side in (56..=224).step_by(14) {
            let request = embedding_request(std::slice::from_ref(&crop), side);
            let decoded: CropsRequest = wire::decode(&wire::encode(&request).unwrap()).unwrap();
            let rgb = &decoded.crops[0];
            let worker =
                image::RgbImage::from_raw(rgb.width, rgb.height, rgb.pixels.clone()).unwrap();
            let mut local_tensor = vec![0.; 3 * side as usize * side as usize];
            let mut worker_tensor = local_tensor.clone();
            taphoa_recognition::crop::normalize_into(&crop, &mut local_tensor, side);
            taphoa_recognition::crop::normalize_into(&worker, &mut worker_tensor, side);
            assert_eq!(local_tensor, worker_tensor, "side {side}");
        }
    }
    #[tokio::test]
    async fn large_crops_reach_worker_in_bounded_batches() {
        use axum::{Router, body::Bytes, http::header, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = Router::new().route(
            "/v1/embed-crops",
            post(move |bytes: Bytes| {
                let seen = seen.clone();
                async move {
                    let request: CropsRequest = wire::decode(&bytes).unwrap();
                    let side = request.crops[0].width;
                    for crop in &request.crops {
                        assert_eq!((crop.width, crop.height), (side, side));
                        assert!(side <= 224);
                    }
                    seen.fetch_add(1, Ordering::SeqCst);
                    (
                        [(header::CONTENT_TYPE, CONTENT_TYPE)],
                        wire::encode(&EmbeddingResponse {
                            model: format!("dinov2-vits14-onnx@1/{side}"),
                            dim: 384,
                            vectors: vec![vec![1. / (384f32).sqrt(); 384]; request.crops.len()],
                        })
                        .unwrap(),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let remote = ready_remote(
            &url,
            "a-crop-transport-token-at-least-32-characters",
            AppState::default(),
        )
        .unwrap();
        // Incompressible full-size RGB exceeds the wire limit even as PNG.
        let mut noise = 0x12345678u32;
        let large = image::RgbImage::from_fn(2200, 1700, |_, _| {
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            image::Rgb([noise as u8, (noise >> 8) as u8, (noise >> 16) as u8])
        });
        let mut png = std::io::Cursor::new(Vec::new());
        large.write_to(&mut png, image::ImageFormat::Png).unwrap();
        assert!(png.get_ref().len() > BODY_LIMIT);
        let mut crops = vec![image::RgbImage::new(32, 64); 8];
        crops.push(large);
        let result = tokio::task::spawn_blocking(move || remote.embed_crops(&crops))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.len(), 9);
        // Nine crops at the default side fit one request; oversized originals are resized.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
    #[tokio::test]
    async fn a_twenty_detection_scan_embeds_in_one_worker_call() {
        use axum::{Router, body::Bytes, http::header, routing::post};
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let seen = sizes.clone();
        let app = Router::new()
            .route(
                "/v1/embed-crops",
                post(move |bytes: Bytes| {
                    let seen = seen.clone();
                    async move {
                        let request: CropsRequest = wire::decode(&bytes).unwrap();
                        seen.lock().unwrap().push(request.crops.len());
                        (
                            [(header::CONTENT_TYPE, CONTENT_TYPE)],
                            wire::encode(&EmbeddingResponse {
                                model: "dinov2-vits14-onnx@1/112".into(),
                                dim: 384,
                                vectors: vec![vec![1. / (384f32).sqrt(); 384]; request.crops.len()],
                            })
                            .unwrap(),
                        )
                    }
                }),
            )
            .layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let remote = ready_remote(
            &url,
            "a-crop-transport-token-at-least-32-characters",
            AppState::default(),
        )
        .unwrap();
        assert_eq!(remote.side, 112);
        let remote = Arc::new(remote);
        for (count, expected) in [
            (20usize, vec![20usize]),
            (64, vec![64]),
            (65, vec![64, 1]),
            (130, vec![64, 64, 2]),
        ] {
            sizes.lock().unwrap().clear();
            let remote = remote.clone();
            let crops = vec![image::RgbImage::new(40, 40); count];
            let vectors = tokio::task::spawn_blocking(move || remote.embed_crops(&crops))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(vectors.len(), count);
            assert_eq!(*sizes.lock().unwrap(), expected);
        }
        server.abort();
    }
    #[test]
    fn crop_batches_are_few_and_fit_the_worker_and_wire_limits() {
        // A 20-detection scan is one worker round trip at the default side.
        assert_eq!(crops_per_request(112), 64);
        assert_eq!(crops_per_request(224), 27);
        for side in (56..=224).step_by(14) {
            let per_request = crops_per_request(side);
            assert!((1..=64).contains(&per_request));
            // Real encoded request of a full batch, and of one crop more than fits.
            let crop = image::RgbImage::new(300, 200);
            let full = wire::encode(&embedding_request(&vec![crop.clone(); per_request], side))
                .unwrap()
                .len();
            assert!(full < 4 * 1024 * 1024, "side {side}: {full} bytes");
            assert!(full < BODY_LIMIT);
            if per_request < 64 {
                let over = wire::encode(&embedding_request(&vec![crop; per_request + 1], side))
                    .unwrap()
                    .len();
                assert!(over > 4 * 1024 * 1024, "side {side}");
            }
        }
    }
    #[test]
    fn oversized_crop_and_maximum_batches_fit_the_wire_limit() {
        let crop = image::RgbImage::new(4096, 4096);
        assert!(
            wire::encode(&CropsRequest {
                crops: vec![RgbCrop {
                    width: 4096,
                    height: 4096,
                    pixels: crop.as_raw().clone()
                }]
            })
            .is_err()
        );
        let resized = taphoa_recognition::crop::resize_for_embedding(&crop, 224).into_owned();
        let request = embedding_request(&vec![resized; 8], 224);
        let bytes = wire::encode(&request).unwrap();
        assert_eq!(bytes.len(), 8 + 8 * (16 + 224 * 224 * 3));
        assert!(bytes.len() < BODY_LIMIT);
    }
}
