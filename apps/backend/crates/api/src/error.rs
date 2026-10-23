use axum::{
    Json,
    extract::{FromRequest, Request},
    http::{StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    retry_after_secs: Option<u64>,
}
pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after_secs: None,
        }
    }
    pub fn bad_request(code: &'static str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, msg)
    }
    pub fn validation_failed(msg: impl Into<String>) -> Self {
        Self::bad_request("validation_failed", msg)
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        )
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "permission denied")
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "record not found")
    }
    pub fn conflict(code: &'static str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, msg)
    }
    pub fn gone() -> Self {
        Self::new(StatusCode::GONE, "gone", "resource no longer available")
    }
    pub fn too_many_requests(retry_after_secs: u64) -> Self {
        Self {
            retry_after_secs: Some(retry_after_secs),
            ..Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "rate limit exceeded",
            )
        }
    }
    pub fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "service unavailable",
        )
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({"error": self.message, "code": self.code})),
        )
            .into_response();
        if let Some(seconds) = self.retry_after_secs {
            response.headers_mut().insert(RETRY_AFTER, seconds.into());
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database operation failed");
        Self::internal()
    }
}

/// JSON extractor with the API's stable validation error envelope.
pub struct ValidJson<T>(pub T);
impl<S, T> FromRequest<S> for ValidJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;
    async fn from_request(request: Request, state: &S) -> ApiResult<Self> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|rejection| ApiError::validation_failed(rejection.body_text()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::Request,
        routing::post,
    };
    use serde::Deserialize;
    use tower::ServiceExt;

    #[tokio::test]
    async fn errors_have_stable_codes_and_retry_header() {
        let response = ApiError::too_many_requests(12).into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[RETRY_AFTER], "12");
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"error":"rate limit exceeded", "code":"too_many_requests"})
        );
        assert_eq!(
            ApiError::from(sqlx::Error::RowNotFound).status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    #[derive(Deserialize)]
    struct Input {
        count: u32,
    }
    #[tokio::test]
    async fn invalid_json_is_400_validation_failed() {
        let app = Router::new().route(
            "/",
            post(|ValidJson(input): ValidJson<Input>| async move { input.count.to_string() }),
        );
        for body in ["{", r#"{"count":"wrong"}"#, "{}"] {
            let response = app
                .clone()
                .oneshot(
                    Request::post("/")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                    .unwrap();
            assert_eq!(body["code"], "validation_failed");
        }
    }
    #[test]
    fn constructor_statuses() {
        for (error, status, code) in [
            (ApiError::bad_request("bad", "bad"), 400, "bad"),
            (ApiError::unauthorized(), 401, "unauthorized"),
            (ApiError::forbidden(), 403, "forbidden"),
            (ApiError::not_found(), 404, "not_found"),
            (
                ApiError::conflict("id_conflict", "conflict"),
                409,
                "id_conflict",
            ),
            (ApiError::gone(), 410, "gone"),
            (ApiError::unavailable(), 503, "unavailable"),
            (ApiError::internal(), 500, "internal"),
        ] {
            assert_eq!(error.status.as_u16(), status);
            assert_eq!(error.code, code);
        }
    }
}
