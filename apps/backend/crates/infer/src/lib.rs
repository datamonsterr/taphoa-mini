//! Small inference-only service. No cloud credentials or persistence.
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Extension, Request, State},
    http::{StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use taphoa_recognition::{
    Embedder, ImageEncoding, PointSegmenter, SegmentError, Segmenter,
    ocr::{OcrError, ReceiptOcr, TextDetector},
    wire::{self, *},
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
    fn run(&mut self, operation: &str, bytes: &[u8]) -> Result<Vec<u8>, Failure> {
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
                pack(
                    self.models
                        .embedder
                        .embed_crops(&crops)
                        .map_err(embed_failure)?,
                )
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
                dimensions(&request.image)?;
                match operation {
                    "segment" => pack(self.models.segmenter.segment(&request.image)?),
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
                    "embed" => pack(
                        self.models
                            .embedder
                            .embed(&request.image)
                            .map_err(embed_failure)?,
                    ),
                    "detect-text" => pack(self.models.detector.detect(&request.image)?),
                    "document-signal" => {
                        pack(self.models.detector.document_signal(&request.image)?)
                    }
                    "read-lines" => pack(self.models.ocr.read_lines(&request.image)?),
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
        taphoa_recognition::EmbedError::InvalidImage(s) => Failure::bad(s),
        e => Failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "inference_failed",
            e.to_string(),
        ),
    }
}
struct Job {
    operation: String,
    bytes: Bytes,
    deadline: Instant,
    reply: oneshot::Sender<Result<Vec<u8>, Failure>>,
    // Retained until native work ends, including after request cancellation/timeout.
    _permit: Arc<OwnedSemaphorePermit>,
}
#[derive(Clone)]
pub struct Service {
    token_hash: [u8; 32],
    sender: mpsc::Sender<Job>,
    slots: Arc<Semaphore>,
    provider: String,
}
impl Service {
    pub fn new(models: Models, token: &str, provider: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            token.chars().count() >= 32,
            "INFERENCE_TOKEN must contain at least 32 characters"
        );
        let (sender, mut receiver) = mpsc::channel::<Job>(QUEUE_SIZE);
        tokio::task::spawn_blocking(move || {
            let mut engine = Engine {
                models,
                encodings: VecDeque::new(),
            };
            while let Some(job) = receiver.blocking_recv() {
                if job.reply.is_closed() {
                    continue;
                }
                let result = if Instant::now() >= job.deadline {
                    Err(Failure::timeout())
                } else {
                    engine.run(&job.operation, &job.bytes)
                };
                let _ = job.reply.send(result);
            }
        });
        Ok(Self {
            token_hash: Sha256::digest(token.as_bytes()).into(),
            sender,
            slots: Arc::new(Semaphore::new(QUEUE_SIZE + 1)),
            provider: provider.into(),
        })
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
    }
}
async fn guard(State(service): State<Service>, mut request: Request, next: Next) -> Response {
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
    let (reply, receiver) = oneshot::channel();
    let operation = uri.path().trim_start_matches("/v1/").to_owned();
    service
        .sender
        .try_send(Job {
            operation,
            bytes,
            deadline,
            reply,
            _permit: permit,
        })
        .map_err(|_| Failure::busy())?;
    let bytes = receiver.await.map_err(|_| Failure::busy())??;
    Ok(([(header::CONTENT_TYPE, CONTENT_TYPE)], bytes).into_response())
}
async fn health(State(service): State<Service>) -> axum::Json<Health> {
    axum::Json(Health {
        status: "ready".into(),
        provider: service.provider,
        loaded: vec!["sam".into(), "dinov2".into(), "ocr".into()],
        version: env!("CARGO_PKG_VERSION").into(),
    })
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
    fn fake() -> Models {
        Models {
            segmenter: Arc::new(taphoa_recognition::MockSegmenter::default()),
            points: Arc::new(taphoa_recognition::MockPointSegmenter::default()),
            embedder: Arc::new(taphoa_recognition::MockEmbedder),
            detector: Arc::new(taphoa_recognition::ocr::FakeTextDetector::default()),
            ocr: Arc::new(taphoa_recognition::ocr::FakeReceiptOcr::default()),
        }
    }
    fn photo(width: u32, height: u32) -> Vec<u8> {
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
