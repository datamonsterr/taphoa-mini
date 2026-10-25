//! Contract coverage uses the real router and scoped subscribers, never process env.
use axum::{body::Body, http::Request};
use opentelemetry::{
    Key, Value,
    logs::AnyValue,
    trace::{SpanKind, Status},
};
use opentelemetry_sdk::{
    logs::{InMemoryLogExporter, SdkLoggerProvider},
    trace::{InMemorySpanExporter, SdkTracerProvider, SpanData},
};
use taphoa_api::{
    AppState, router,
    telemetry::{self, TelemetryConfig},
};
use tower::ServiceExt;
use tracing_subscriber::prelude::*;

fn config() -> TelemetryConfig {
    TelemetryConfig::from_lookup(
        |name| match name {
            "OTEL_SERVICE_NAME" => Some("contract-api".into()),
            "SERVICE_VERSION" => Some("test-sha".into()),
            "TELEMETRY_ENVIRONMENT" => Some("test".into()),
            _ => None,
        },
        || None,
    )
}
fn attr(span: &SpanData, name: &str) -> Option<Value> {
    span.attributes
        .iter()
        .find(|kv| kv.key.as_str() == name)
        .map(|kv| kv.value.clone())
}
#[derive(Debug)]
struct ResourceCapture {
    inner: InMemorySpanExporter,
    resource: std::sync::Arc<std::sync::Mutex<opentelemetry_sdk::Resource>>,
}
impl opentelemetry_sdk::trace::SpanExporter for ResourceCapture {
    async fn export(&self, spans: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
        opentelemetry_sdk::trace::SpanExporter::export(&self.inner, spans).await
    }
    fn set_resource(&mut self, resource: &opentelemetry_sdk::Resource) {
        *self.resource.lock().unwrap() = resource.clone();
    }
}
struct Capture {
    spans: InMemorySpanExporter,
    logs: InMemoryLogExporter,
    resource: std::sync::Arc<std::sync::Mutex<opentelemetry_sdk::Resource>>,
    traces: SdkTracerProvider,
    logger: SdkLoggerProvider,
}
impl Capture {
    fn new() -> Self {
        let spans = InMemorySpanExporter::default();
        let logs = InMemoryLogExporter::default();
        let resource = config().resource();
        let captured_resource = std::sync::Arc::new(std::sync::Mutex::new(
            opentelemetry_sdk::Resource::builder_empty().build(),
        ));
        let exporter = ResourceCapture {
            inner: spans.clone(),
            resource: captured_resource.clone(),
        };
        let traces = SdkTracerProvider::builder()
            .with_resource(resource.clone())
            .with_simple_exporter(exporter)
            .build();
        let logger = SdkLoggerProvider::builder()
            .with_resource(resource)
            .with_simple_exporter(logs.clone())
            .build();
        Self {
            spans,
            logs,
            resource: captured_resource,
            traces,
            logger,
        }
    }
    fn subscriber(&self) -> impl tracing::Subscriber + use<> {
        tracing_subscriber::registry().with(telemetry::otel_layers(&self.traces, &self.logger))
    }
}

#[test]
fn config_precedence_and_disabled_export() {
    let empty = TelemetryConfig::from_lookup(|_| None, || None);
    assert!(!empty.enabled());
    assert_eq!(empty.service_name, "taphoa-backend");
    assert_eq!(empty.environment, "local");
    assert_eq!(empty.version, env!("CARGO_PKG_VERSION"));
    let values = |name: &str| match name {
        "OTEL_EXPORTER_OTLP_ENDPOINT" => Some("https://collector.example".into()),
        "RAILWAY_ENVIRONMENT_NAME" => Some("production".into()),
        "RAILWAY_GIT_COMMIT_SHA" => Some("railway-sha".into()),
        _ => None,
    };
    let railway = TelemetryConfig::from_lookup(values, || Some("file-sha\nignored".into()));
    assert!(railway.enabled());
    assert_eq!(railway.environment, "production");
    assert_eq!(railway.version, "railway-sha");
    let file = TelemetryConfig::from_lookup(|_| None, || Some("file-sha\nignored".into()));
    assert_eq!(file.version, "file-sha");
    let override_config = TelemetryConfig::from_lookup(
        |name| match name {
            "SERVICE_VERSION" => Some("override-sha".into()),
            "TELEMETRY_ENVIRONMENT" => Some("eval".into()),
            "OTEL_SERVICE_NAME" => Some("custom-api".into()),
            _ => values(name),
        },
        || panic!("version file must be read lazily"),
    );
    assert_eq!(override_config.version, "override-sha");
    assert_eq!(override_config.environment, "eval");
    assert_eq!(override_config.service_name, "custom-api");
    assert!(
        !TelemetryConfig::from_lookup(
            |name| (name == "OTEL_EXPORTER_OTLP_ENDPOINT").then(|| "  ".into()),
            || None
        )
        .enabled()
    );
    let disabled = TelemetryConfig::from_lookup(
        |name| {
            if name == "OTEL_SDK_DISABLED" {
                Some("true".into())
            } else {
                values(name)
            }
        },
        || None,
    );
    assert!(!disabled.enabled());
    assert_eq!(config().version, "test-sha");
}

#[tokio::test(flavor = "current_thread")]
async fn health_span_access_log_resource_and_remote_parent() {
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    let response = router(AppState::default())
        .oneshot(
            Request::get("/healthz?x=1")
                .header(
                    "traceparent",
                    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                )
                .header("x-posthog-session-id", "session-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let spans = capture.spans.get_finished_spans().unwrap();
    let span = spans
        .iter()
        .find(|s| s.name == "GET /healthz")
        .expect("HTTP server span");
    assert_eq!(span.span_kind, SpanKind::Server);
    assert_eq!(
        span.span_context.trace_id().to_string(),
        "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    assert_eq!(span.parent_span_id.to_string(), "00f067aa0ba902b7");
    for (key, expected) in [
        ("http.request.method", "GET"),
        ("http.route", "/healthz"),
        ("url.path", "/healthz"),
        ("posthog.session_id", "session-123"),
    ] {
        assert_eq!(attr(span, key), Some(expected.into()), "{key}");
    }
    assert_eq!(
        attr(span, "http.response.status_code"),
        Some(200_i64.into())
    );
    assert!(
        !span
            .attributes
            .iter()
            .any(|kv| kv.key.as_str().starts_with("taphoa.member")
                || kv.key.as_str() == "user.id"
                || kv.key.as_str() == "session.id")
    );
    let logs = capture.logs.get_emitted_logs().unwrap();
    assert_eq!(logs.len(), 1, "exactly one access log");
    let log = &logs[0];
    let context = log.record.trace_context().expect("log trace context");
    assert_eq!(context.trace_id, span.span_context.trace_id());
    assert_eq!(context.span_id, span.span_context.span_id());
    assert_eq!(
        log.record.severity_number(),
        Some(opentelemetry::logs::Severity::Info)
    );
    assert_eq!(
        log.record.target().map(|s| s.as_ref()),
        Some("taphoa_api::telemetry")
    );
    for (key, expected) in [
        ("http.route", AnyValue::String("/healthz".into())),
        ("http.response.status_code", AnyValue::Int(200)),
        ("posthog.session_id", AnyValue::String("session-123".into())),
    ] {
        assert!(
            log.record
                .attributes_iter()
                .any(|(k, v)| k.as_str() == key && *v == expected),
            "{key}"
        );
    }
    assert!(
        log.record
            .attributes_iter()
            .any(|(k, v)| k.as_str() == "duration_ms"
                && matches!(v, AnyValue::Double(value) if *value >= 0.0))
    );
    for (key, value) in [
        ("service.name", "contract-api"),
        ("service.version", "test-sha"),
        ("deployment.environment.name", "test"),
        ("langfuse.environment", "test"),
    ] {
        assert_eq!(
            log.resource.get(&Key::from_static_str(key)),
            Some(value.into())
        );
        assert_eq!(
            capture
                .resource
                .lock()
                .unwrap()
                .get(&Key::from_static_str(key)),
            Some(value.into())
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn errors_and_unmatched_routes_have_safe_attributes() {
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    for path in [
        "/v1/images/00000000-0000-0000-0000-000000000001",
        "/readyz",
        "/not-a-route?private=value",
    ] {
        router(AppState::default())
            .oneshot(
                Request::get(path)
                    .header("authorization", "Bearer bad")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    let spans = capture.spans.get_finished_spans().unwrap();
    let unauthorized = spans
        .iter()
        .find(|s| attr(s, "http.response.status_code") == Some(401_i64.into()))
        .expect("unauthorized route");
    assert_eq!(
        attr(unauthorized, "taphoa.error.code"),
        Some("unauthorized".into())
    );
    assert_eq!(
        spans
            .iter()
            .find(|s| s.name == "GET /readyz")
            .unwrap()
            .status,
        Status::error("")
    );
    let missing = spans.iter().find(|s| s.name == "GET").unwrap();
    assert_eq!(attr(missing, "http.route"), None);
    assert_eq!(attr(missing, "url.path"), Some("/not-a-route".into()));
}

#[tokio::test(flavor = "current_thread")]
async fn identity_child_logs_db_events_and_job_contract() {
    use axum::{Router, routing::get};
    use taphoa_api::auth::{Actor, Role};
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    let state = AppState::default();
    let actor = Actor {
        member_id: uuid::Uuid::new_v4(),
        store_id: uuid::Uuid::new_v4(),
        session_id: uuid::Uuid::new_v4(),
        role: Role::Seller,
        can_enroll: false,
    };
    let (token, _) = state.jwt.issue(&actor);
    // The same public middleware as router(); no production route is added.
    let app = Router::new().route("/actor", get(|_: Actor| async {
        let child = tracing::info_span!("handler child");
        let _entered = child.enter();
            let _unentered = tracing::info_span!("unentered child");
        tracing::info!("authenticated handler");
        tracing::debug!("local debug only");
        tracing::debug!(target: "sqlx::query", summary = "SELECT private", db.statement = "SELECT secret FROM members WHERE token='never-export'", rows_affected = 0_u64, rows_returned = 1_u64, elapsed_secs = 0.025_f64);
        tracing::warn!(target: "sqlx::query", summary = "UPDATE private", db.statement = "UPDATE members SET token='never-export'", rows_affected = 1_u64, rows_returned = 0_u64, elapsed_secs = 0.1_f64);
    })).layer(axum::middleware::from_fn(telemetry::http_span)).with_state(state);
    assert_eq!(
        app.oneshot(
            Request::get("/actor")
                .header("authorization", format!("Bearer {token}"))
                .header("x-posthog-session-id", "posthog-auth")
                .body(Body::empty())
                .unwrap()
        )
        .await
        .unwrap()
        .status(),
        200
    );
    let spans = capture.spans.get_finished_spans().unwrap();
    let server = spans.iter().find(|s| s.name == "GET /actor").unwrap();
    let child = spans.iter().find(|s| s.name == "handler child").unwrap();
    let db = spans
        .iter()
        .find(|s| s.name == "db SELECT members")
        .expect("sqlx client span");
    assert_eq!(db.parent_span_id, child.span_context.span_id());
    assert_eq!(db.span_kind, SpanKind::Client);
    assert_eq!(attr(db, "db.system.name"), Some("postgresql".into()));
    assert_eq!(attr(db, "db.operation.name"), Some("SELECT".into()));
    assert_eq!(attr(db, "db.collection.name"), Some("members".into()));
    assert!(
        db.end_time
            .duration_since(db.start_time)
            .unwrap()
            .as_millis()
            >= 25
    );
    let unentered = spans.iter().find(|s| s.name == "unentered child").unwrap();
    for span in [server, child, db, unentered] {
        for (key, value) in [
            ("taphoa.store.id", actor.store_id.to_string()),
            ("taphoa.member.id", actor.member_id.to_string()),
            ("taphoa.member.role", "seller".into()),
            ("session.id", actor.session_id.to_string()),
        ] {
            assert_eq!(attr(span, key), Some(value.into()), "{} {key}", span.name);
        }
        assert_eq!(attr(span, "user.id"), None);
        assert!(
            !span
                .attributes
                .iter()
                .any(|kv| matches!(kv.key.as_str(), "summary" | "db.statement"))
        );
    }
    assert!(!format!("{spans:?}").contains("never-export"));
    assert!(spans.iter().any(|s| s.name == "db UPDATE members"));
    let logs = capture.logs.get_emitted_logs().unwrap();
    assert!(!format!("{logs:?}").contains("never-export"));
    assert_eq!(logs.len(), 2, "handler plus access; debug and SQL stay out");
    assert_eq!(
        logs[0].record.trace_context().unwrap().span_id,
        child.span_context.span_id()
    );
    assert_eq!(
        logs[1].record.trace_context().unwrap().span_id,
        server.span_context.span_id()
    );
    for log in &logs {
        assert!(
            log.record
                .attributes_iter()
                .any(|(k, v)| k.as_str() == "taphoa.member.id"
                    && *v == AnyValue::String(actor.member_id.to_string().into()))
        );
    }
    let result = telemetry::job("retention", 1, async {
        tracing::info!("retention work");
        Ok::<_, anyhow::Error>(())
    })
    .await;
    assert!(result.is_ok());
    let spans = capture.spans.get_finished_spans().unwrap();
    let job = spans.iter().find(|s| s.name == "job retention").unwrap();
    assert_eq!(
        attr(job, "taphoa.store.id"),
        None,
        "request identity must not leak into jobs"
    );
    assert_eq!(attr(job, "taphoa.job.name"), Some("retention".into()));
    assert_eq!(attr(job, "taphoa.job.attempt"), Some(1_i64.into()));
    assert_eq!(attr(job, "taphoa.job.outcome"), Some("ok".into()));
    let logs = capture.logs.get_emitted_logs().unwrap();
    assert!(
        logs.last()
            .unwrap()
            .record
            .attributes_iter()
            .any(|(k, v)| k.as_str() == "taphoa.job.name"
                && *v == AnyValue::String("retention".into()))
    );
}

fn poll_outbox_query() {
    tracing::debug!(
        target: "sqlx::query",
        summary = "SELECT id FROM outbox_events",
        db.statement = "SELECT id FROM outbox_events WHERE published_at IS NULL LIMIT 100",
        rows_affected = 0_u64,
        rows_returned = 0_u64,
        elapsed_secs = 0.001_f64
    );
}

#[test]
fn sqlx_events_export_db_spans_only_below_an_active_span() {
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    // Background pollers (outbox relay, index worker) query before they open a job span.
    poll_outbox_query();
    assert!(
        capture.spans.get_finished_spans().unwrap().is_empty(),
        "a query outside any span must not export a root db trace"
    );
    {
        let request = tracing::info_span!("request");
        let _entered = request.enter();
        poll_outbox_query();
    }
    let spans = capture.spans.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 2, "{spans:?}");
    let request = spans.iter().find(|s| s.name == "request").unwrap();
    let db = spans
        .iter()
        .find(|s| s.name == "db SELECT outbox_events")
        .expect("db span below a request span");
    assert_eq!(db.parent_span_id, request.span_context.span_id());
    assert_eq!(db.span_context.trace_id(), request.span_context.trace_id());
}

fn nested_levels() {
    // Dependency-style debug and trace spans (AWS SDK, h2, hyper) must stay local.
    let debug = tracing::debug_span!(target: "h2::codec", "debug child");
    let _debug = debug.enter();
    let trace = tracing::trace_span!(target: "hyper::proto", "trace child");
    let _trace = trace.enter();
    let info = tracing::info_span!("info under debug");
    let _info = info.enter();
    tracing::info!("log inside info span");
}

#[tokio::test(flavor = "current_thread")]
async fn only_info_and_above_spans_are_exported_and_global_max_level_is_bounded() {
    use axum::{Router, routing::get};
    use tracing::{Subscriber as _, level_filters::LevelFilter};
    let capture = Capture::new();
    let subscriber = capture.subscriber();
    // A filter without a level hint would raise the global max level to TRACE and make
    // every dependency trace! callsite evaluate. sqlx::query events need DEBUG.
    assert!(
        matches!(subscriber.max_level_hint(), Some(level) if level <= LevelFilter::DEBUG),
        "{:?}",
        subscriber.max_level_hint()
    );
    let _default = tracing::subscriber::set_default(subscriber);
    let app = Router::new()
        .route(
            "/levels",
            get(|| async {
                nested_levels();
            }),
        )
        .layer(axum::middleware::from_fn(telemetry::http_span));
    assert_eq!(
        app.oneshot(Request::get("/levels").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        200
    );
    let spans = capture.spans.get_finished_spans().unwrap();
    let mut names: Vec<&str> = spans.iter().map(|s| &*s.name).collect();
    names.sort_unstable();
    assert_eq!(names, ["GET /levels", "info under debug"]);
    let server = spans.iter().find(|s| s.name == "GET /levels").unwrap();
    let info = spans.iter().find(|s| s.name == "info under debug").unwrap();
    assert_eq!(info.parent_span_id, server.span_context.span_id());
    let logs = capture.logs.get_emitted_logs().unwrap();
    let inside = logs
        .iter()
        .find(|log| {
            log.record
                .trace_context()
                .is_some_and(|c| c.span_id == info.span_context.span_id())
        })
        .expect("log inside the info span");
    assert!(inside.record.body().is_some());
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires DATABASE_URL pointing to PostgreSQL"]
async fn real_sqlx_query_produces_db_span() {
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .await
        .unwrap();
    let span = tracing::info_span!("query parent");
    use tracing::Instrument;
    sqlx::query("SELECT 1 FROM pg_catalog.pg_class LIMIT 1")
        .execute(&pool)
        .instrument(span)
        .await
        .unwrap();
    assert!(
        capture
            .spans
            .get_finished_spans()
            .unwrap()
            .iter()
            .any(|s| s.name == "db SELECT pg_catalog.pg_class")
    );
    pool.close().await;
}

#[tokio::test(flavor = "current_thread")]
async fn failed_retention_and_client_spans_record_outcome_without_secrets() {
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(5))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    assert!(taphoa_api::retention::run_once(&pool).await.is_err());
    assert!(capture.logs.get_emitted_logs().unwrap().iter().any(|log| {
        log.record.attributes_iter().any(|(key, value)| {
            key.as_str() == "taphoa.job.name" && *value == AnyValue::String("retention".into())
        })
    }));
    let address =
        telemetry::server_address("https://user:secret@storage.example/private?key=secret");
    assert_eq!(address, "storage.example");
    let result =
        telemetry::client("s3 GetObject", &address, async { Err::<(), _>("failure") }).await;
    assert!(result.is_err());
    let spans = capture.spans.get_finished_spans().unwrap();
    let retention = spans.iter().find(|s| s.name == "job retention").unwrap();
    assert_eq!(attr(retention, "taphoa.job.outcome"), Some("error".into()));
    assert_eq!(attr(retention, "taphoa.job.attempt"), Some(1_i64.into()));
    let client = spans.iter().find(|s| s.name == "s3 GetObject").unwrap();
    assert_eq!(client.span_kind, SpanKind::Client);
    assert_eq!(
        attr(client, "server.address"),
        Some("storage.example".into())
    );
    assert_eq!(attr(client, "taphoa.outcome"), Some("error".into()));
    assert!(!format!("{spans:?}").contains("user:secret"));
    pool.close().await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_jobs_and_clients_record_error_once() {
    let capture = Capture::new();
    let _default = tracing::subscriber::set_default(capture.subscriber());
    let pending = || std::future::pending::<Result<(), ()>>();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(1),
            telemetry::job("cancelled", 2, pending())
        )
        .await
        .is_err()
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(1),
            telemetry::client("redis GET", "redis.example", pending())
        )
        .await
        .is_err()
    );
    let spans = capture.spans.get_finished_spans().unwrap();
    for (name, key) in [
        ("job cancelled", "taphoa.job.outcome"),
        ("redis GET", "taphoa.outcome"),
    ] {
        let span = spans.iter().find(|s| s.name == name).unwrap();
        assert_eq!(attr(span, key), Some("error".into()));
        assert_eq!(
            span.attributes
                .iter()
                .filter(|kv| kv.key.as_str() == key)
                .count(),
            1
        );
    }
}
