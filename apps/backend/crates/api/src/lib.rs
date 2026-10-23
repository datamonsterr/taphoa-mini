pub mod auth;
pub mod catalog;
pub mod config;
pub mod error;
pub mod events;
pub mod expenses;
pub mod idempotency;
pub mod images;
pub mod money;
pub mod pagination;
pub mod ratelimit;
pub mod recognition;
pub mod reports;
pub mod retention;
pub mod sales;
pub mod seed;
pub mod storage;
pub mod store;
pub mod sync;
pub mod time;
pub mod vector;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, State, multipart::MultipartError},
    http::StatusCode,
    routing::{get, post},
};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{sync::Arc, time::Duration};
use taphoa_recognition::{Embedder, Segment, SegmentError, Segmenter};
use tokio::sync::Semaphore;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};

pub use error::{ApiError, ApiResult};

pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

#[derive(Clone)]
pub struct AppState {
    pub jwt: auth::JwtKeys,
    pub rate_limiter: Arc<dyn ratelimit::RateLimiter>,
    pub rate_limits: ratelimit::RateLimits,
    pub client_ip: ratelimit::ClientIpSource,
    pub config: Option<Arc<config::Config>>,
    pub postgres: Option<PgPool>,
    pub redis: Option<ConnectionManager>,
    pub hub: events::Hub,
    pub segmenter: Option<Arc<dyn Segmenter>>,
    /// Catalog enrollment embeds reference photos. None -> 503 on enroll.
    pub embedder: Option<Arc<dyn Embedder>>,
    /// Duplicate-check search port. None -> catalog queries product_embeddings in SQL.
    pub vector_index: Option<Arc<dyn vector::VectorIndex>>,
    pub storage: Option<Arc<dyn storage::ObjectStore>>,
    pub image_repository: Option<Arc<dyn images::ImageRepository>>,
    pub image_url_ttl: Duration,
    // Serialize inference and reject excess work before copying/decompressing images.
    pub inference_slots: Arc<Semaphore>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            jwt: auth::JwtKeys::from_secret(&rand::random::<[u8; 32]>()),
            rate_limiter: Arc::new(ratelimit::MemoryRateLimiter::default()),
            rate_limits: ratelimit::RateLimits::default(),
            client_ip: ratelimit::ClientIpSource::default(),
            config: None,
            postgres: None,
            redis: None,
            hub: events::Hub::new(),
            segmenter: None,
            embedder: None,
            vector_index: None,
            storage: None,
            image_repository: None,
            image_url_ttl: Duration::from_secs(900),
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
        Self::connect_options(database_url, redis_url, segmenter, 10).await
    }
    pub async fn connect_with_config(
        config: &config::Config,
        segmenter: Option<Arc<dyn Segmenter>>,
    ) -> anyhow::Result<Self> {
        let mut state = Self::connect_options(
            config.database_url.as_deref(),
            config.redis_url.as_deref(),
            segmenter,
            config.db_max_connections,
        )
        .await?;
        state.jwt = auth::JwtKeys::from_secret(config.jwt_secret.as_bytes());
        state.rate_limits = config.rate_limits;
        state.client_ip = config.client_ip;
        state.config = Some(Arc::new(config.clone()));
        Ok(state)
    }
    async fn connect_options(
        database_url: Option<&str>,
        redis_url: Option<&str>,
        segmenter: Option<Arc<dyn Segmenter>>,
        max_connections: u32,
    ) -> anyhow::Result<Self> {
        let postgres = if let Some(url) = database_url {
            let pool = PgPoolOptions::new()
                .max_connections(max_connections)
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
        let image_repository = postgres.clone().map(|pool| {
            Arc::new(images::PgImageRepository(pool)) as Arc<dyn images::ImageRepository>
        });
        let rate_limiter: Arc<dyn ratelimit::RateLimiter> = match &redis {
            Some(connection) => Arc::new(ratelimit::RedisRateLimiter(connection.clone())),
            None => Arc::new(ratelimit::MemoryRateLimiter::default()),
        };
        Ok(Self {
            rate_limiter,
            image_repository,
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
        .route(
            "/v1/segment",
            post(segment)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
                .layer(RequestBodyLimitLayer::new(MAX_UPLOAD_BYTES)),
        )
        .route(
            "/v1/images",
            post(images::upload)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(
                    images::MAX_IMAGE_REQUEST_BYTES,
                ))
                .layer(RequestBodyLimitLayer::new(images::MAX_IMAGE_REQUEST_BYTES)),
        )
        .route("/v1/images/{id}", get(images::get_image))
        .merge(auth::router())
        .merge(store::router())
        .merge(events::router())
        .merge(catalog::router())
        .merge(recognition::router())
        .merge(sales::router())
        .merge(expenses::router())
        .merge(reports::router())
        .merge(sync::router())
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
    let storage = async {
        match &state.storage {
            Some(storage) => matches!(
                tokio::time::timeout(Duration::from_secs(2), storage.head_bucket()).await,
                Ok(Ok(()))
            ),
            None => true,
        }
    };
    let (postgres, redis, storage) = tokio::join!(postgres, redis, storage);
    let storage_status = if state.storage.is_none() {
        "not configured"
    } else if storage {
        "ok"
    } else {
        "unavailable"
    };
    let mut failed = Vec::new();
    if !postgres {
        failed.push("postgres");
    }
    if !redis {
        failed.push("redis");
    }
    if !storage {
        failed.push("storage");
    }
    if failed.is_empty() {
        (
            StatusCode::OK,
            Json(json!({"status":"ok", "storage":storage_status})),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unavailable", "dependencies":failed, "storage":storage_status})),
        )
    }
}

fn bad_request() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "validation_failed",
        "expected one multipart image field containing a PNG or JPEG",
    )
}

// Body limits can be nested through both tower-http and axum body wrappers.
fn multipart_error(error: MultipartError) -> ApiError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(cause) = source {
        if cause.is::<http_body_util::LengthLimitError>() {
            return ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "image upload too large",
            );
        }
        source = cause.source();
    }
    ApiError::new(
        error.status(),
        "validation_failed",
        "invalid multipart body",
    )
}

async fn segment(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Vec<Segment>>, ApiError> {
    let segmenter = state.segmenter.ok_or(ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "no model loaded",
    ))?;
    let permit = state.inference_slots.try_acquire_owned().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "segmenter busy",
        )
    })?;
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
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "inference failed",
        )
    })?;
    result.map(Json).map_err(|error| match error {
        SegmentError::InvalidImage(_) => bad_request(),
        error => {
            tracing::error!(%error, "segmentation failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "inference failed",
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::Response;
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
        assert_eq!(
            json_body(response).await,
            json!({"error":"no model loaded", "code":"unavailable"})
        );
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
