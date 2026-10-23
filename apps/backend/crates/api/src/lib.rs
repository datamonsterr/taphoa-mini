use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, State, multipart::MultipartError},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{sync::Arc, time::Duration};
use taphoa_recognition::{Segment, SegmentError, Segmenter};
use tokio::sync::Semaphore;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};

pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

#[derive(Clone)]
pub struct AppState {
    pub postgres: Option<PgPool>,
    pub redis: Option<ConnectionManager>,
    pub segmenter: Option<Arc<dyn Segmenter>>,
    // Serialize inference and reject excess work before copying/decompressing images.
    pub inference_slots: Arc<Semaphore>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            postgres: None,
            redis: None,
            segmenter: None,
            inference_slots: Arc::new(Semaphore::new(1)),
        }
    }
}
impl AppState {
    pub async fn connect(
        database_url: Option<&str>,
        redis_url: Option<&str>,
        segmenter: Option<Arc<dyn Segmenter>>,
    ) -> anyhow::Result<Self> {
        let postgres = if let Some(url) = database_url {
            let pool = PgPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(Duration::from_secs(3))
                .connect(url)
                .await?;
            MIGRATOR.run(&pool).await?;
            Some(pool)
        } else {
            None
        };
        let redis = if let Some(url) = redis_url {
            let client = redis::Client::open(url)?;
            Some(
                tokio::time::timeout(Duration::from_secs(5), ConnectionManager::new(client))
                    .await??,
            )
        } else {
            None
        };
        Ok(Self {
            postgres,
            redis,
            segmenter,
            ..Self::default()
        })
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/segment", post(segment))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .layer(RequestBodyLimitLayer::new(MAX_UPLOAD_BYTES))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz() -> Json<Value> {
    Json(json!({"status":"ok"}))
}

async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let postgres = async {
        if let Some(pool) = &state.postgres {
            matches!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    sqlx::query("SELECT 1").execute(pool)
                )
                .await,
                Ok(Ok(_))
            )
        } else {
            false
        }
    };
    let redis = async {
        if let Some(mut connection) = state.redis.clone() {
            matches!(tokio::time::timeout(Duration::from_secs(2), redis::cmd("PING").query_async::<String>(&mut connection)).await,
                Ok(Ok(ref reply)) if reply == "PONG")
        } else {
            false
        }
    };
    let (postgres, redis) = tokio::join!(postgres, redis);
    let mut failed = Vec::new();
    if !postgres {
        failed.push("postgres");
    }
    if !redis {
        failed.push("redis");
    }
    if failed.is_empty() {
        (StatusCode::OK, Json(json!({"status":"ok"})))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unavailable", "dependencies":failed})),
        )
    }
}

struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn bad_request() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "expected one multipart image field containing a PNG or JPEG",
    )
}

// Body limits can be nested through both tower-http and axum body wrappers.
fn multipart_error(error: MultipartError) -> ApiError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(cause) = source {
        if cause.is::<http_body_util::LengthLimitError>() {
            return ApiError(StatusCode::PAYLOAD_TOO_LARGE, "image upload too large");
        }
        source = cause.source();
    }
    ApiError(error.status(), "invalid multipart body")
}

async fn segment(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Vec<Segment>>, ApiError> {
    let segmenter = state
        .segmenter
        .ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "no model loaded"))?;
    let permit = state
        .inference_slots
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "segmenter busy"))?;
    let mut image = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        if field.name() != Some("image") || image.is_some() {
            return Err(bad_request());
        }
        let bytes = field.bytes().await.map_err(multipart_error)?;
        if bytes.is_empty() {
            return Err(bad_request());
        }
        image = Some(bytes);
    }
    let image = image.ok_or_else(bad_request)?;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit; // Remains held even if the HTTP request is cancelled.
        segmenter.segment(&image)
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "segmentation task failed");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "inference failed")
    })?;
    result.map(Json).map_err(|error| match error {
        SegmentError::InvalidImage(_) => bad_request(),
        error => {
            tracing::error!(%error, "segmentation failed");
            ApiError(StatusCode::INTERNAL_SERVER_ERROR, "inference failed")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use taphoa_recognition::MockSegmenter;
    use tower::ServiceExt;

    fn multipart(field: &str, data: &[u8]) -> Request<Body> {
        let mut body = format!("--test\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n--test--\r\n");
        Request::post("/v1/segment")
            .header("content-type", "multipart/form-data; boundary=test")
            .body(Body::from(body))
            .unwrap()
    }
    fn mock_state() -> AppState {
        AppState {
            segmenter: Some(Arc::new(MockSegmenter {
                segments: vec![Segment {
                    bbox: [1., 2., 3., 4.],
                    score: 0.95,
                    area: 12,
                }],
            })),
            ..AppState::default()
        }
    }
    async fn json_body(response: Response) -> Value {
        serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_UPLOAD_BYTES)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn health_is_dependency_independent() {
        let response = router(AppState::default())
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await, json!({"status":"ok"}));
    }
    #[tokio::test]
    async fn segments_multipart_image_with_mock() {
        let response = router(mock_state())
            .oneshot(multipart(
                "image",
                include_bytes!("../../../tests/fixtures/sample.png"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json_body(response).await,
            json!([{"bbox":[1.,2.,3.,4.],"score":0.95,"area":12}])
        );
    }
    #[tokio::test]
    async fn missing_model_returns_503() {
        let response = router(AppState::default())
            .oneshot(multipart("image", b"sample"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json_body(response).await["error"], "no model loaded");
    }
    #[tokio::test]
    async fn missing_dependencies_are_named() {
        let response = router(AppState::default())
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            json_body(response).await["dependencies"],
            json!(["postgres", "redis"])
        );
    }
    #[tokio::test]
    async fn invalid_fields_and_empty_images_are_rejected() {
        for request in [multipart("wrong", b"sample"), multipart("image", b"")] {
            assert_eq!(
                router(mock_state())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }
    #[tokio::test]
    async fn oversized_upload_is_rejected() {
        let response = router(mock_state())
            .oneshot(multipart("image", &vec![0; MAX_UPLOAD_BYTES + 1]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
