//! Small inference-only service. No cloud credentials or persistence.
pub mod transport;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Extension, MatchedPath, Request, State},
    http::{StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use http_body_util::BodyExt;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use taphoa_recognition::{
    Embedder, ImageEncoding, PointSegmenter, SegmentError, Segmenter,
    ocr::{OcrError, OcrLimits, ReceiptOcr, ReceiptOptions, TextDetector},
    wire::{self, *},
    work::WorkControl,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

pub const DEADLINE: Duration = Duration::from_secs(10);
pub const QUEUE_SIZE: usize = 2;
const ENCODING_LIMIT: usize = 16;
const ENCODING_TTL: Duration = Duration::from_secs(300);

pub struct Models {
    pub segmenter: Arc<dyn Segmenter>,
    pub points: Arc<dyn PointSegmenter>,
    pub embedder: Arc<dyn Embedder>,
    pub detector: Arc<dyn TextDetector>,
    pub ocr: Arc<dyn ReceiptOcr>,
}
struct CachedEncoding {
    handle: String,
    created: Instant,
    encoding: Arc<ImageEncoding>,
}
struct Engine {
    models: Models,
    encodings: VecDeque<CachedEncoding>,
}
#[derive(Debug)]
struct Failure(StatusCode, &'static str, String);
impl Failure {
    fn bad(message: impl ToString) -> Self {
        Self(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            message.to_string(),
        )
    }
    fn busy() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "inference queue full".into(),
        )
    }
    fn timeout() -> Self {
        Self(
            StatusCode::GATEWAY_TIMEOUT,
            "deadline",
            "inference deadline exceeded".into(),
        )
    }
}
impl From<SegmentError> for Failure {
    fn from(e: SegmentError) -> Self {
        match e {
            SegmentError::Cancelled(_) => Self::timeout(),
            SegmentError::InvalidImage(s) => Self::bad(s),
            SegmentError::InvalidPrompt(s) => {
                Self(StatusCode::UNPROCESSABLE_ENTITY, "invalid_prompt", s)
            }
            e => Self(
                StatusCode::INTERNAL_SERVER_ERROR,
                "inference_failed",
                e.to_string(),
            ),
        }
    }
}
impl From<OcrError> for Failure {
    fn from(e: OcrError) -> Self {
        match e {
            OcrError::Cancelled(_) => Self::timeout(),
            OcrError::LimitExceeded(message) => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                "ocr_work_limit",
                message.into(),
            ),
            OcrError::InvalidImage(s) => Self::bad(s),
            e => Self(
                StatusCode::INTERNAL_SERVER_ERROR,
                "inference_failed",
                e.to_string(),
            ),
        }
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let mut response = (
            self.0,
            [(header::CONTENT_TYPE, CONTENT_TYPE)],
            wire::encode(&ErrorResponse {
                code: self.1.into(),
                message: self.2,
            })
            .unwrap_or_default(),
        )
            .into_response();
        if self.0 == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "1".parse().unwrap());
        }
        response
    }
}
fn unpack<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Failure> {
    wire::decode(bytes).map_err(Failure::bad)
}
fn pack<T: Serialize>(value: T) -> Result<Vec<u8>, Failure> {
    wire::encode(&value).map_err(|e| Failure(StatusCode::INTERNAL_SERVER_ERROR, "encode_failed", e))
}
/// Inspect headers before model code may decode/allocate a photo.
fn dimensions(bytes: &[u8]) -> Result<(u32, u32), Failure> {
    let format = taphoa_recognition::crop::sniff_format(bytes)
        .ok_or_else(|| Failure::bad("expected JPEG or PNG"))?;
    let (w, h) = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(Failure::bad)?;
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        return Err(Failure::bad("image dimensions must be 1..4096"));
    }
    Ok((w, h))
}
impl Engine {
    #[cfg(test)]
    fn run(&mut self, operation: &str, bytes: &[u8]) -> Result<Vec<u8>, Failure> {
        self.run_controlled(
            operation,
            bytes,
            &WorkControl::new(Instant::now() + DEADLINE),
        )
    }
    fn run_controlled(
        &mut self,
        operation: &str,
        bytes: &[u8],
        control: &WorkControl,
    ) -> Result<Vec<u8>, Failure> {
        control.check().map_err(|_| Failure::timeout())?;
        match operation {
            "embed-crops" => {
                let request: CropsRequest = unpack(bytes)?;
                if request.crops.is_empty() || request.crops.len() > 64 {
                    return Err(Failure::bad("expected 1..64 crops"));
                }
                let mut crops = Vec::with_capacity(request.crops.len());
                for crop in request.crops {
                    if crop.width == 0
                        || crop.height == 0
                        || crop.width > 4096
                        || crop.height > 4096
                        || u64::from(crop.width) * u64::from(crop.height) * 3
                            != crop.pixels.len() as u64
                    {
                        return Err(Failure::bad("invalid RGB crop dimensions/length"));
                    }
                    crops.push(
                        image::RgbImage::from_raw(crop.width, crop.height, crop.pixels)
                            .ok_or_else(|| Failure::bad("invalid crop"))?,
                    );
                }
                pack(EmbeddingResponse {
                    model: self.models.embedder.model().into(),
                    dim: self.models.embedder.dim(),
                    vectors: self
                        .models
                        .embedder
                        .embed_crops_with_control(&crops, control)
                        .map_err(embed_failure)?,
                })
            }
            "decode-points" => {
                let request: PointsRequest = unpack(bytes)?;
                self.encodings
                    .retain(|e| e.created.elapsed() < ENCODING_TTL);
                let cached = self
                    .encodings
                    .iter()
                    .find(|e| e.handle == request.handle)
                    .ok_or_else(|| {
                        Failure(
                            StatusCode::GONE,
                            "unknown_encoding",
                            "encoding expired or unknown".into(),
                        )
                    })?;
                taphoa_recognition::validate_points(
                    &request.points,
                    cached.encoding.width,
                    cached.encoding.height,
                )?;
                pack(PointResponse::from_segment(
                    self.models
                        .points
                        .decode_points(&cached.encoding, &request.points)?,
                ))
            }
            "segment" | "encode" | "embed" | "detect-text" | "document-signal" | "read-lines" => {
                let request: ImageRequest = unpack(bytes)?;
                let (width, height) = dimensions(&request.image)?;
                match operation {
                    "segment" => pack(
                        self.models
                            .segmenter
                            .segment_with_control(&request.image, control)?,
                    ),
                    "encode" => {
                        let encoding = self.models.points.encode(&request.image)?;
                        let handle = uuid::Uuid::new_v4().to_string();
                        let response = EncodingResponse {
                            handle: handle.clone(),
                            width: encoding.width,
                            height: encoding.height,
                        };
                        self.encodings
                            .retain(|e| e.created.elapsed() < ENCODING_TTL);
                        while self.encodings.len() >= ENCODING_LIMIT {
                            self.encodings.pop_front();
                        }
                        self.encodings.push_back(CachedEncoding {
                            handle,
                            created: Instant::now(),
                            encoding,
                        });
                        pack(response)
                    }
                    "embed" => pack(EmbeddingResponse {
                        model: self.models.embedder.model().into(),
                        dim: self.models.embedder.dim(),
                        vectors: vec![
                            self.models
                                .embedder
                                .embed_with_control(&request.image, control)
                                .map_err(embed_failure)?,
                        ],
                    }),
                    "detect-text" | "document-signal" => {
                        let boxes = self.models.detector.detect(&request.image)?;
                        if boxes.len() > OcrLimits::default().max_boxes {
                            return Err(
                                OcrError::LimitExceeded("too many detected text boxes").into()
                            );
                        }
                        control.check().map_err(|_| Failure::timeout())?;
                        if operation == "detect-text" {
                            pack(boxes)
                        } else {
                            pack(taphoa_recognition::ocr::document_signal(
                                &boxes, width, height,
                            ))
                        }
                    }
                    "read-lines" => pack(self.models.ocr.read_lines_with_options(
                        &request.image,
                        Some(&ReceiptOptions {
                            limits: Some(OcrLimits::default()),
                            control: Some(control),
                        }),
                    )?),
                    _ => unreachable!(),
                }
            }
            _ => Err(Failure(
                StatusCode::NOT_FOUND,
                "not_found",
                "unknown operation".into(),
            )),
        }
    }
}
fn embed_failure(e: taphoa_recognition::EmbedError) -> Failure {
    match e {
        taphoa_recognition::EmbedError::Cancelled(_) => Failure::timeout(),
        taphoa_recognition::EmbedError::InvalidImage(s) => Failure::bad(s),
        e => Failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "inference_failed",
            e.to_string(),
        ),
    }
}
enum Command {
    Infer(Job),
    Stop,
}

struct CancelOnDrop(WorkControl);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

struct Liveness(Arc<AtomicBool>);
impl Drop for Liveness {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct Job {
    operation: String,
    bytes: Bytes,
    control: WorkControl,
    reply: oneshot::Sender<Result<Vec<u8>, Failure>>,
    // Retained until native work ends, including after request cancellation/timeout.
    _permit: Arc<OwnedSemaphorePermit>,
}
#[derive(Clone)]
pub struct Service {
    token_hash: [u8; 32],
    sender: mpsc::Sender<Command>,
    alive: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    engine_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    slots: Arc<Semaphore>,
    provider: String,
}
impl Service {
    pub fn new(models: Models, token: &str, provider: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            token.chars().count() >= 32,
            "INFERENCE_TOKEN must contain at least 32 characters"
        );
        let (sender, mut receiver) = mpsc::channel::<Command>(QUEUE_SIZE);
        let alive = Arc::new(AtomicBool::new(true));
        let liveness = Liveness(alive.clone());
        let task = tokio::task::spawn_blocking(move || {
            let _liveness = liveness;
            let mut engine = Engine {
                models,
                encodings: VecDeque::new(),
            };
            while let Some(command) = receiver.blocking_recv() {
                let Command::Infer(job) = command else {
                    break;
                };
                if job.reply.is_closed() {
                    continue;
                }
                let result = engine.run_controlled(&job.operation, &job.bytes, &job.control);
                let _ = job.reply.send(result);
            }
        });
        Ok(Self {
            token_hash: Sha256::digest(token.as_bytes()).into(),
            sender,
            alive,
            stopping: Arc::new(AtomicBool::new(false)),
            engine_task: Arc::new(Mutex::new(Some(task))),
            slots: Arc::new(Semaphore::new(QUEUE_SIZE + 1)),
            provider: provider.into(),
        })
    }
    /// Main races this supervisor with the HTTP server. A failed engine makes
    /// main return Err (non-zero exit) rather than reuse potentially poisoned models.
    pub async fn supervise(&self) -> anyhow::Result<()> {
        let task = self
            .engine_task
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow::anyhow!("engine supervisor already running"))?;
        if let Err(error) = task.await {
            tracing::error!(%error, "inference engine terminated");
            anyhow::bail!("inference engine task failed: {error}");
        }
        if !self.stopping.load(Ordering::Acquire) {
            tracing::error!("inference engine exited unexpectedly without a shutdown request");
            anyhow::bail!("inference engine exited unexpectedly");
        }
        Ok(())
    }
    /// Called only once HTTP connections have drained.
    pub async fn stop_engine(&self) -> anyhow::Result<()> {
        self.stopping.store(true, Ordering::Release);
        self.sender
            .send(Command::Stop)
            .await
            .map_err(|_| anyhow::anyhow!("inference engine already stopped"))
    }
    pub fn router(self) -> Router {
        let mut protected = Router::new();
        for path in [
            "segment",
            "encode",
            "decode-points",
            "embed",
            "embed-crops",
            "detect-text",
            "document-signal",
            "read-lines",
        ] {
            protected = protected.route(&format!("/v1/{path}"), post(infer));
        }
        protected = protected
            .fallback(|| async {
                Failure(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "unknown operation".into(),
                )
            })
            .layer(DefaultBodyLimit::max(BODY_LIMIT))
            .layer(middleware::from_fn_with_state(self.clone(), guard));
        Router::new()
            .route("/healthz", get(health))
            .merge(protected)
            .with_state(self)
            .layer(middleware::from_fn(access_log))
    }
}
async fn access_log(request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1/") {
        return next.run(request).await;
    }
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("/v1/unknown", MatchedPath::as_str)
        .to_owned();
    let started = Instant::now();
    let bytes = Arc::new(AtomicU64::new(0));
    let received = bytes.clone();
    let (parts, body) = request.into_parts();
    let body = Body::new(body.inspect_frame(move |frame| {
        if let Some(data) = frame.data_ref() {
            received.fetch_add(data.len() as u64, Ordering::Relaxed);
        }
    }));
    let response = next.run(Request::from_parts(parts, body)).await;
    tracing::info!(
        route,
        status = response.status().as_u16(),
        bytes_in = bytes.load(Ordering::Relaxed),
        duration_ms = started.elapsed().as_millis() as u64,
        "inference request"
    );
    response
}
async fn guard(State(service): State<Service>, mut request: Request, next: Next) -> Response {
    if !service.alive.load(Ordering::Acquire) {
        return Failure::busy().into_response();
    }
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    if !bool::from(hash.ct_eq(&service.token_hash)) {
        return Failure(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid credentials".into(),
        )
        .into_response();
    }
    let permit = match service.slots.clone().try_acquire_owned() {
        Ok(p) => Arc::new(p),
        Err(_) => return Failure::busy().into_response(),
    };
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some(CONTENT_TYPE)
    {
        return Failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "wire_version",
            "expected inference v1 binary content type".into(),
        )
        .into_response();
    }
    let deadline = Instant::now() + DEADLINE;
    request.extensions_mut().insert(permit);
    request.extensions_mut().insert(deadline);
    match tokio::time::timeout(DEADLINE, next.run(request)).await {
        Ok(r) => r,
        Err(_) => Failure::timeout().into_response(),
    }
}
async fn infer(
    State(service): State<Service>,
    Extension(permit): Extension<Arc<OwnedSemaphorePermit>>,
    Extension(deadline): Extension<Instant>,
    uri: Uri,
    bytes: Bytes,
) -> Result<Response, Failure> {
    let control = WorkControl::new(deadline);
    let _cancel = CancelOnDrop(control.clone());
    let (reply, receiver) = oneshot::channel();
    let operation = uri.path().trim_start_matches("/v1/").to_owned();
    service
        .sender
        .try_send(Command::Infer(Job {
            operation,
            bytes,
            control,
            reply,
            _permit: permit,
        }))
        .map_err(|_| Failure::busy())?;
    let bytes = receiver.await.map_err(|_| Failure::busy())??;
    Ok(([(header::CONTENT_TYPE, CONTENT_TYPE)], bytes).into_response())
}
async fn health(State(service): State<Service>) -> impl IntoResponse {
    let alive = service.alive.load(Ordering::Acquire);
    (
        if alive {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        axum::Json(Health {
            status: if alive { "ready" } else { "not_ready" }.into(),
            provider: service.provider,
            loaded: vec!["sam".into(), "dinov2".into(), "ocr".into()],
            version: env!("CARGO_PKG_VERSION").into(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;
    const TOKEN: &str = "a-test-token-with-at-least-32-characters";
    pub(crate) fn fake() -> Models {
        Models {
            segmenter: Arc::new(taphoa_recognition::MockSegmenter::default()),
            points: Arc::new(taphoa_recognition::MockPointSegmenter::default()),
            embedder: Arc::new(taphoa_recognition::MockEmbedder),
            detector: Arc::new(taphoa_recognition::ocr::FakeTextDetector::default()),
            ocr: Arc::new(taphoa_recognition::ocr::FakeReceiptOcr::default()),
        }
    }
    pub(crate) fn photo(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbImage::new(width, height)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }
    fn request(path: &str, token: Option<&str>, body: Vec<u8>) -> Request<Body> {
        let mut request = Request::post(path).header(header::CONTENT_TYPE, CONTENT_TYPE);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        request.body(Body::from(body)).unwrap()
    }
    #[tokio::test]
    async fn auth_body_limit_validation_and_public_health() {
        assert!(Service::new(fake(), "short", "cpu").is_err());
        let service = Service::new(fake(), TOKEN, "cpu").unwrap();
        let app = service.router();
        let bytes = wire::encode(&ImageRequest { image: photo(2, 2) }).unwrap();
        for token in [None, Some("wrong")] {
            assert_eq!(
                app.clone()
                    .oneshot(request("/v1/segment", token, bytes.clone()))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            app.clone()
                .oneshot(request("/v1/segment", Some(TOKEN), bytes))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/v1/segment", Some(TOKEN), vec![0; BODY_LIMIT + 1]))
                .await
                .unwrap()
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        for image in [vec![0; 10], photo(4097, 1)] {
            assert_eq!(
                app.clone()
                    .oneshot(request(
                        "/v1/segment",
                        Some(TOKEN),
                        wire::encode(&ImageRequest { image }).unwrap()
                    ))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        let health = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&to_bytes(health.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["status"], "ready");
        assert_eq!(value["provider"], "cpu");
    }
    #[tokio::test]
    async fn saturated_admission_returns_retry_after_and_releases_on_cancel() {
        let service = Service::new(fake(), TOKEN, "cpu").unwrap();
        let permit = service
            .slots
            .clone()
            .acquire_many_owned((QUEUE_SIZE + 1) as u32)
            .await
            .unwrap();
        let response = service
            .clone()
            .router()
            .oneshot(request("/v1/segment", Some(TOKEN), vec![]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        drop(permit);
        assert_eq!(service.slots.available_permits(), QUEUE_SIZE + 1);
    }
    #[tokio::test]
    async fn encoding_cache_is_bounded_and_unknown_expired_handles_are_distinct() {
        let mut engine = Engine {
            models: fake(),
            encodings: VecDeque::new(),
        };
        let bytes = wire::encode(&ImageRequest { image: photo(2, 2) }).unwrap();
        let first: EncodingResponse = unpack(&engine.run("encode", &bytes).unwrap()).unwrap();
        for _ in 0..ENCODING_LIMIT {
            engine.run("encode", &bytes).unwrap();
        }
        assert_eq!(engine.encodings.len(), ENCODING_LIMIT);
        let points = vec![taphoa_recognition::PointPrompt {
            x: 1.,
            y: 1.,
            label: 1,
        }];
        let gone = engine
            .run(
                "decode-points",
                &wire::encode(&PointsRequest {
                    handle: first.handle,
                    points: points.clone(),
                })
                .unwrap(),
            )
            .unwrap_err();
        assert_eq!((gone.0, gone.1), (StatusCode::GONE, "unknown_encoding"));
        let last = engine.encodings.back_mut().unwrap();
        last.created = Instant::now() - ENCODING_TTL;
        let handle = last.handle.clone();
        assert_eq!(
            engine
                .run(
                    "decode-points",
                    &wire::encode(&PointsRequest { handle, points }).unwrap()
                )
                .unwrap_err()
                .0,
            StatusCode::GONE
        );
        let bad = wire::encode(&CropsRequest {
            crops: vec![RgbCrop {
                width: u32::MAX,
                height: u32::MAX,
                pixels: vec![],
            }],
        })
        .unwrap();
        assert_eq!(
            engine.run("embed-crops", &bad).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;
    const TOKEN: &str = "lifecycle-test-token-at-least-32-characters";
    fn request() -> Request<Body> {
        Request::post("/v1/segment")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, CONTENT_TYPE)
            .body(Body::from(
                wire::encode(&ImageRequest {
                    image: crate::tests::photo(2, 2),
                })
                .unwrap(),
            ))
            .unwrap()
    }
    struct Panicking {
        calls: Arc<std::sync::atomic::AtomicUsize>,
        poison: Mutex<()>,
    }
    impl Segmenter for Panicking {
        fn segment(&self, _: &[u8]) -> Result<Vec<taphoa_recognition::Segment>, SegmentError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let _lock = self.poison.lock().unwrap();
            panic!("intentional decoder panic");
        }
    }
    #[tokio::test]
    async fn panic_marks_unready_supervisor_fails_and_poisoned_model_is_never_reused() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut models = crate::tests::fake();
        models.segmenter = Arc::new(Panicking {
            calls: calls.clone(),
            poison: Mutex::new(()),
        });
        let service = Service::new(models, TOKEN, "cpu").unwrap();
        let router = service.clone().router();
        assert_eq!(
            router.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let response = router
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let health: Health =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(health.status, "not_ready");
        assert!(
            service
                .supervise()
                .await
                .unwrap_err()
                .to_string()
                .contains("panicked")
        );
        assert_eq!(
            router.oneshot(request()).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn only_deliberate_shutdown_allows_a_clean_engine_exit() {
        let service = Service::new(crate::tests::fake(), TOKEN, "cpu").unwrap();
        service.sender.send(Command::Stop).await.unwrap();
        assert!(
            service
                .supervise()
                .await
                .unwrap_err()
                .to_string()
                .contains("unexpectedly")
        );
        let service = Service::new(crate::tests::fake(), TOKEN, "cpu").unwrap();
        service.stop_engine().await.unwrap();
        service.supervise().await.unwrap();
    }
    struct Cancellable {
        started: Arc<tokio::sync::Notify>,
        stopped: Arc<tokio::sync::Notify>,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl Segmenter for Cancellable {
        fn segment(&self, _: &[u8]) -> Result<Vec<taphoa_recognition::Segment>, SegmentError> {
            panic!("controlled method required")
        }
        fn segment_with_control(
            &self,
            _: &[u8],
            control: &WorkControl,
        ) -> Result<Vec<taphoa_recognition::Segment>, SegmentError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                return Ok(Vec::new());
            }
            self.started.notify_one();
            loop {
                if let Err(error) = control.check() {
                    self.stopped.notify_one();
                    return Err(error.into());
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    #[tokio::test]
    async fn abandoned_request_cancels_active_work_and_engine_accepts_next_job() {
        let started = Arc::new(tokio::sync::Notify::new());
        let stopped = Arc::new(tokio::sync::Notify::new());
        let mut models = crate::tests::fake();
        models.segmenter = Arc::new(Cancellable {
            started: started.clone(),
            stopped: stopped.clone(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let service = Service::new(models, TOKEN, "cpu").unwrap();
        let router = service.clone().router();
        let pending = tokio::spawn(router.clone().oneshot(request()));
        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .unwrap();
        pending.abort();
        let _ = pending.await;
        tokio::time::timeout(Duration::from_secs(1), stopped.notified())
            .await
            .unwrap();
        assert_eq!(
            router.oneshot(request()).await.unwrap().status(),
            StatusCode::OK
        );
        service.stop_engine().await.unwrap();
        service.supervise().await.unwrap();
    }
    struct TooDense;
    impl ReceiptOcr for TooDense {
        fn read_lines(&self, _: &[u8]) -> Result<Vec<taphoa_recognition::ocr::OcrLine>, OcrError> {
            panic!("worker must supply options")
        }
        fn read_lines_with_options(
            &self,
            _: &[u8],
            options: Option<&ReceiptOptions<'_>>,
        ) -> Result<Vec<taphoa_recognition::ocr::OcrLine>, OcrError> {
            let options = options.unwrap();
            assert_eq!(options.limits.unwrap().max_boxes, 512);
            assert!(options.control.is_some());
            Err(OcrError::LimitExceeded("too many detected text boxes"))
        }
    }
    #[tokio::test]
    async fn ocr_budget_rejection_is_a_distinct_client_error() {
        let mut models = crate::tests::fake();
        models.ocr = Arc::new(TooDense);
        let service = Service::new(models, TOKEN, "cpu").unwrap();
        let mut request = request();
        *request.uri_mut() = "/v1/read-lines".parse().unwrap();
        let response = service.clone().router().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error: ErrorResponse =
            wire::decode(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(error.code, "ocr_work_limit");
        assert!(service.alive.load(Ordering::Acquire));
    }
}
