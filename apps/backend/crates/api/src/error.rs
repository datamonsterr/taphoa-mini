use axum::{
    Json,
    extract::{
        FromRequest, Request,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
    retry_after_secs: Option<u64>,
}
pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
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
    /// A 403 that tells the caller what only the Lead may do.
    pub fn forbidden_with(msg: &'static str) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", msg)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "record not found")
    }
    pub fn conflict(code: &'static str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, msg)
    }
    /// 413 for a request body over a route's size limit.
    pub fn payload_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "request body too large",
        )
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
    /// Attach a `Retry-After` hint (seconds) to the response.
    pub fn with_retry_after(mut self, seconds: u64) -> Self {
        self.retry_after_secs = Some(seconds);
        self
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({"error": self.message, "code": self.code});
        if let Some(details) = self.details {
            body["details"] = details;
        }
        let mut response = (self.status, Json(body)).into_response();
        response
            .extensions_mut()
            .insert(crate::telemetry::ErrorCode(self.code));
        if let Some(seconds) = self.retry_after_secs {
            response.headers_mut().insert(RETRY_AFTER, seconds.into());
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        log_sqlx_error!(error, &error, "database operation failed");
        Self::internal()
    }
}

/// Log-safe summary of a sqlx error. Logs are exported, and Postgres messages echo bound
/// values (`invalid input syntax for type uuid: "<value>"`, `Key (name)=(<value>) already
/// exists`), so the Display text must never be logged. Only the SQLSTATE, the constraint
/// name (schema metadata) and a stable kind are kept.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SqlxLog {
    pub kind: &'static str,
    pub sqlstate: Option<String>,
    pub constraint: Option<String>,
}
impl SqlxLog {
    pub(crate) fn of(error: &sqlx::Error) -> Self {
        let database = error.as_database_error();
        Self {
            kind: sqlx_kind(error),
            sqlstate: database
                .and_then(|e| e.code())
                .map(|code| code.into_owned()),
            constraint: database.and_then(|e| e.constraint()).map(str::to_owned),
        }
    }
    /// The sqlx error anywhere in an anyhow chain, with or without added context.
    pub(crate) fn in_chain(error: &anyhow::Error) -> Option<Self> {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<sqlx::Error>())
            .map(Self::of)
    }
}
fn sqlx_kind(error: &sqlx::Error) -> &'static str {
    use sqlx::Error as E;
    match error {
        E::Database(_) => "database",
        E::Io(_) => "io",
        E::Tls(_) => "tls",
        E::Protocol(_) => "protocol",
        E::RowNotFound => "row_not_found",
        E::PoolTimedOut => "pool_timed_out",
        E::PoolClosed => "pool_closed",
        E::WorkerCrashed => "worker_crashed",
        E::Configuration(_) => "configuration",
        E::InvalidArgument(_) => "invalid_argument",
        E::TypeNotFound { .. } => "type_not_found",
        E::ColumnIndexOutOfBounds { .. } => "column_index_out_of_bounds",
        E::ColumnNotFound(_) => "column_not_found",
        E::ColumnDecode { .. } => "column_decode",
        E::Encode(_) => "encode",
        E::Decode(_) => "decode",
        E::Migrate(_) => "migrate",
        _ => "other",
    }
}

/// `log_sqlx_error!(level, &sqlx_error, [fields,] "message")`: log a sqlx error through
/// `SqlxLog` instead of its Display text.
macro_rules! log_sqlx_error {
    ($level:ident, $error:expr, $($rest:tt)+) => {
        $crate::error::log_db_error!($level, &$crate::error::SqlxLog::of($error), $($rest)+)
    };
}
/// `log_anyhow_error!(level, &anyhow_error, [fields,] "message")`: like `log_sqlx_error!`
/// when the chain holds a sqlx error, otherwise logs the error's Display as before.
macro_rules! log_anyhow_error {
    ($level:ident, $error:expr, $($rest:tt)+) => {{
        let error: &anyhow::Error = $error;
        match $crate::error::SqlxLog::in_chain(error) {
            Some(safe) => $crate::error::log_db_error!($level, &safe, $($rest)+),
            None => tracing::$level!(%error, $($rest)+),
        }
    }};
}
macro_rules! log_db_error {
    ($level:ident, $safe:expr, $($rest:tt)+) => {{
        let safe: &$crate::error::SqlxLog = $safe;
        tracing::$level!(
            db.error.kind = safe.kind,
            db.sqlstate = safe.sqlstate.as_deref(),
            db.constraint = safe.constraint.as_deref(),
            $($rest)+
        )
    }};
}
pub(crate) use {log_anyhow_error, log_db_error, log_sqlx_error};

/// Last log line before the process exits, so startup and serve failures reach the
/// exported logs. Database causes are reduced to `SqlxLog` like every other log site.
pub fn log_fatal(error: &anyhow::Error) {
    log_anyhow_error!(error, error, "backend stopped with error");
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
            .map_err(ApiError::from)
    }
}

/// Extractor rejections carry serde and parser text (field names, byte offsets, repeated
/// brackets). It goes to the debug log; the client gets a short fixed message and a stable code.
impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        tracing::debug!(detail = %rejection.body_text(), "request body rejected");
        match rejection {
            JsonRejection::BytesRejection(_)
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE =>
            {
                Self::payload_too_large()
            }
            JsonRejection::MissingJsonContentType(_) => Self::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "content type must be application/json",
            ),
            JsonRejection::JsonDataError(_) => Self::validation_failed("invalid JSON body fields"),
            _ => Self::validation_failed("invalid JSON body"),
        }
    }
}
impl From<QueryRejection> for ApiError {
    fn from(rejection: QueryRejection) -> Self {
        tracing::debug!(detail = %rejection.body_text(), "query string rejected");
        Self::validation_failed("invalid query string")
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
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const VALUE: &str = "Nguyen Van A private customer";

    /// Postgres messages echo bound values: `Key (name)=(...) already exists`.
    #[derive(Debug)]
    struct PgError(String);
    impl std::fmt::Display for PgError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
    }
    impl std::error::Error for PgError {}
    impl sqlx::error::DatabaseError for PgError {
        fn message(&self) -> &str {
            &self.0
        }
        fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
            Some("23505".into())
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
        fn constraint(&self) -> Option<&str> {
            Some("customers_store_id_name_key")
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::UniqueViolation
        }
    }
    fn leaking_error() -> sqlx::Error {
        sqlx::Error::Database(Box::new(PgError(format!(
            "duplicate key value violates unique constraint \"customers_store_id_name_key\": \
             Key (name)=({VALUE}) already exists"
        ))))
    }

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
        type Writer = Captured;
        fn make_writer(&'a self) -> Captured {
            self.clone()
        }
    }
    /// Everything logged while `work` runs, as the local fmt layer would print it.
    fn logged(work: impl FnOnce()) -> String {
        let out = Captured::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(out.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, work);
        let bytes = out.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn database_errors_are_logged_without_their_message_text() {
        let line = logged(|| {
            let response = ApiError::from(leaking_error());
            assert_eq!(response.code, "internal");
        });
        assert!(line.contains("database operation failed"), "{line}");
        assert!(line.contains("23505"), "{line}");
        assert!(line.contains("customers_store_id_name_key"), "{line}");
        assert!(!line.contains(VALUE), "bound value leaked: {line}");
        assert!(!line.contains("already exists"), "message leaked: {line}");
    }

    #[test]
    fn sqlx_log_keeps_sqlstate_constraint_and_stable_kind_only() {
        assert_eq!(
            SqlxLog::of(&leaking_error()),
            SqlxLog {
                kind: "database",
                sqlstate: Some("23505".into()),
                constraint: Some("customers_store_id_name_key".into()),
            }
        );
        for (error, kind) in [
            (sqlx::Error::PoolTimedOut, "pool_timed_out"),
            (sqlx::Error::RowNotFound, "row_not_found"),
            (sqlx::Error::Io(std::io::Error::other(VALUE)), "io"),
            (sqlx::Error::Protocol(VALUE.into()), "protocol"),
            (
                sqlx::Error::ColumnNotFound(VALUE.into()),
                "column_not_found",
            ),
        ] {
            let safe = SqlxLog::of(&error);
            assert_eq!(safe.kind, kind);
            assert_eq!((safe.sqlstate, safe.constraint), (None, None));
        }
    }

    #[test]
    fn anyhow_chains_with_a_sqlx_error_are_logged_without_its_text() {
        let line = logged(|| {
            let error = anyhow::Error::from(leaking_error()).context("polling failed");
            log_anyhow_error!(warn, &error, job_id = 7, "index job failed");
            let plain = anyhow::anyhow!("storage unreachable");
            log_anyhow_error!(warn, &plain, "storage step failed");
        });
        assert!(line.contains("index job failed"), "{line}");
        assert!(line.contains("job_id=7"), "{line}");
        assert!(line.contains("23505"), "{line}");
        assert!(!line.contains(VALUE), "bound value leaked: {line}");
        assert!(!line.contains("polling failed"), "{line}");
        // Errors without sqlx keep their Display text.
        assert!(line.contains("storage unreachable"), "{line}");
    }

    #[test]
    fn fatal_errors_log_one_line_without_database_text() {
        let line = logged(|| {
            log_fatal(&anyhow::Error::from(leaking_error()).context("connecting"));
            log_fatal(&anyhow::anyhow!("DATABASE_URL is required"));
        });
        assert_eq!(line.lines().count(), 2, "{line}");
        assert!(line.contains("backend stopped with error"), "{line}");
        assert!(line.contains("23505"), "{line}");
        assert!(!line.contains(VALUE), "bound value leaked: {line}");
        // Errors without sqlx keep their Display text (config errors name variables only).
        assert!(line.contains("DATABASE_URL is required"), "{line}");
    }

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
