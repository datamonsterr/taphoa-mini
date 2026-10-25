//! Backend telemetry boundary: signal setup, safe request attributes and adapter spans.
use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};
use opentelemetry::{
    KeyValue,
    propagation::{Extractor, TextMapPropagator},
    trace::{Span as _, SpanKind, TraceContextExt as _, Tracer, TracerProvider},
};
use opentelemetry_appender_tracing::layer::{OpenTelemetryTracingBridge, TracingSpanAttributes};
use opentelemetry_otlp::{ExporterBuildError, Protocol, WithExportConfig};
use opentelemetry_sdk::{
    Resource,
    logs::SdkLoggerProvider,
    propagation::TraceContextPropagator,
    trace::{SdkTracer, SdkTracerProvider},
};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime},
};
use tracing::{
    Instrument, Level, Metadata, Subscriber,
    field::{Field, Visit},
    level_filters::LevelFilter,
    span::{Attributes, Id, Record},
};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{
    EnvFilter, Layer,
    filter::{FilterFn, filter_fn},
    layer::Context,
    prelude::*,
    registry::LookupSpan,
};

const INHERITED: &[&str] = &[
    "user.id",
    "taphoa.store.id",
    "taphoa.member.id",
    "taphoa.member.role",
    "session.id",
    "posthog.session_id",
    "taphoa.job.name",
    "taphoa.error.code",
];

// No Debug: standard OTLP headers may contain credentials.
pub struct TelemetryConfig {
    pub endpoint: Option<String>,
    pub service_name: String,
    pub environment: String,
    pub version: String,
    disabled: bool,
}
impl TelemetryConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(
            |name| std::env::var(name).ok(),
            || std::fs::read_to_string(".service-version").ok(),
        )
    }
    /// Injectable environment and file lookup; no process-global mutation in tests.
    pub fn from_lookup(
        get: impl Fn(&str) -> Option<String>,
        version_file: impl FnOnce() -> Option<String>,
    ) -> Self {
        let nonempty = |name| get(name).filter(|value| !value.trim().is_empty());
        Self {
            endpoint: nonempty("OTEL_EXPORTER_OTLP_ENDPOINT"),
            disabled: get("OTEL_SDK_DISABLED").is_some_and(|v| v.eq_ignore_ascii_case("true")),
            service_name: nonempty("OTEL_SERVICE_NAME").unwrap_or_else(|| "taphoa-backend".into()),
            environment: nonempty("TELEMETRY_ENVIRONMENT")
                .or_else(|| nonempty("RAILWAY_ENVIRONMENT_NAME"))
                .unwrap_or_else(|| "local".into()),
            version: nonempty("SERVICE_VERSION")
                .or_else(|| nonempty("RAILWAY_GIT_COMMIT_SHA"))
                .or_else(|| {
                    version_file().and_then(|s| {
                        s.lines()
                            .next()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    })
                })
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into()),
        }
    }
    pub fn enabled(&self) -> bool {
        self.endpoint.is_some() && !self.disabled
    }
    fn base_endpoint(&self) -> &str {
        self.endpoint.as_deref().unwrap_or("").trim_end_matches('/')
    }
    pub fn resource(&self) -> Resource {
        Resource::builder_empty()
            .with_attributes([
                KeyValue::new("service.name", self.service_name.clone()),
                KeyValue::new("service.version", self.version.clone()),
                KeyValue::new("deployment.environment.name", self.environment.clone()),
            ])
            .build()
    }
}

#[derive(Default)]
pub struct TelemetryGuard {
    traces: Option<SdkTracerProvider>,
    logs: Option<SdkLoggerProvider>,
}
impl TelemetryGuard {
    /// Call after requests and background jobs have drained. Attempt all four operations.
    pub fn shutdown(mut self) {
        if let Some(provider) = self.traces.take() {
            let _ = provider.force_flush();
            let _ = provider.shutdown();
        }
        if let Some(provider) = self.logs.take() {
            let _ = provider.force_flush();
            let _ = provider.shutdown();
        }
    }
}

/// Install the global subscriber. The caller installs the rustls ring provider first (see
/// `main`); the exporter's TLS client needs it. A bad exporter configuration must not
/// crash-loop the service: it degrades to the plain fmt subscriber, logs one error and
/// exports nothing. Only failing to install any subscriber at all panics.
pub fn init(config: TelemetryConfig) -> TelemetryGuard {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
    let (guard, failure) = export_guard(&config);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("taphoa_api=info,tower_http=info"));
    let json = std::env::var("LOG_FORMAT").as_deref() == Ok("json");
    subscriber(&guard, filter, json)
        .try_init()
        .expect("install tracing subscriber");
    if let Some(failure) = failure {
        tracing::error!(error = %failure, "telemetry export disabled; continuing with local logs only");
    }
    guard
}

/// Providers for an enabled config, or an empty guard plus the redacted reason export is
/// off. No process-global state, so the failure path is unit-testable. The reason never
/// echoes the endpoint (it may embed credentials); header values cannot appear in it
/// because the builder silently drops invalid headers.
fn export_guard(config: &TelemetryConfig) -> (TelemetryGuard, Option<String>) {
    if !config.enabled() {
        return (TelemetryGuard::default(), None);
    }
    match build_providers(config) {
        Ok((traces, logs)) => (
            TelemetryGuard {
                traces: Some(traces),
                logs: Some(logs),
            },
            None,
        ),
        Err(error) => {
            let endpoint = config.base_endpoint();
            let mut reason = error.to_string();
            if !endpoint.is_empty() {
                reason = reason.replace(endpoint, "<endpoint>");
            }
            (TelemetryGuard::default(), Some(reason))
        }
    }
}

fn build_providers(
    config: &TelemetryConfig,
) -> Result<(SdkTracerProvider, SdkLoggerProvider), ExporterBuildError> {
    let endpoint = config.base_endpoint();
    // Builders read and percent-decode standard OTEL_EXPORTER_OTLP_HEADERS themselves.
    // Explicit signal paths preserve the base-endpoint semantics for injected configs.
    let traces = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{endpoint}/v1/traces"))
        .build()?;
    let logs = opentelemetry_otlp::LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{endpoint}/v1/logs"))
        .build()?;
    Ok((
        SdkTracerProvider::builder()
            .with_resource(config.resource())
            .with_batch_exporter(traces)
            .build(),
        SdkLoggerProvider::builder()
            .with_resource(config.resource())
            .with_batch_exporter(logs)
            .build(),
    ))
}

/// The process subscriber: local fmt output plus OTel layers when both providers exist.
fn subscriber(
    guard: &TelemetryGuard,
    filter: EnvFilter,
    json: bool,
) -> impl Subscriber + Send + Sync + use<> {
    let otel = guard
        .traces
        .as_ref()
        .zip(guard.logs.as_ref())
        .map(|(t, l)| otel_layers(t, l));
    // SQL events are consumed only by SqlxLayer, even when RUST_LOG enables sqlx.
    let exporting = otel.is_some();
    let local = filter_fn(move |m| !exporting || m.target() != SQLX_QUERY);
    let fmt = if json {
        tracing_subscriber::fmt::layer()
            .json()
            .with_filter(local)
            .with_filter(filter)
            .boxed()
    } else {
        tracing_subscriber::fmt::layer()
            .with_filter(local)
            .with_filter(filter)
            .boxed()
    };
    tracing_subscriber::registry().with(otel).with(fmt)
}

/// Build scoped OTel layers with caller-owned providers (including in-memory exporters).
/// Span and event filters are deliberately independent of the local RUST_LOG filter.
pub fn otel_layers<S>(
    traces: &SdkTracerProvider,
    logs: &SdkLoggerProvider,
) -> impl Layer<S> + use<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let tracer = traces.tracer("taphoa.backend");
    tracing_opentelemetry::layer()
        .with_tracer(tracer.clone())
        .with_filter(exported_spans())
        .and_then(
            OpenTelemetryTracingBridge::builder(logs)
                .with_tracing_span_attributes(TracingSpanAttributes::allowlist(
                    INHERITED.iter().copied(),
                ))
                .build()
                .with_filter(
                    filter_fn(|m| {
                        *m.level() <= Level::INFO && (m.is_span() || m.target() != SQLX_QUERY)
                    })
                    .with_max_level_hint(LevelFilter::INFO),
                ),
        )
        .and_then(InheritanceLayer::default().with_filter(exported_spans()))
        .and_then(
            SqlxLayer(tracer).with_filter(
                filter_fn(|m| {
                    if m.is_span() {
                        *m.level() <= Level::INFO
                    } else {
                        m.target() == SQLX_QUERY && *m.level() <= Level::DEBUG
                    }
                })
                .with_max_level_hint(LevelFilter::DEBUG),
            ),
        )
}

const SQLX_QUERY: &str = "sqlx::query";

/// Spans at INFO or above. Dependency debug/trace spans (AWS SDK, h2, hyper) stay local.
/// The level hint keeps the subscriber's global max level below TRACE: filter_fn alone
/// has no hint, which would make every dependency trace! callsite evaluate.
fn exported_spans() -> FilterFn<impl Fn(&Metadata<'_>) -> bool> {
    filter_fn(|m: &Metadata<'_>| m.is_span() && *m.level() <= Level::INFO)
        .with_max_level_hint(LevelFilter::INFO)
}

#[derive(Clone, Default)]
struct Inherited(BTreeMap<&'static str, String>);
impl Visit for Inherited {
    fn record_str(&mut self, field: &Field, value: &str) {
        if let Some(key) = INHERITED.iter().find(|key| **key == field.name()) {
            self.0.insert(key, value.to_owned());
        }
    }
    fn record_debug(&mut self, _: &Field, _: &dyn std::fmt::Debug) {}
}

#[derive(Default)]
struct InheritanceLayer {
    dispatch: OnceLock<tracing::dispatcher::WeakDispatch>,
}
impl<S> Layer<S> for InheritanceLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_register_dispatch(&self, dispatch: &tracing::Dispatch) {
        let _ = self.dispatch.set(dispatch.downgrade());
    }
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("registered span");
        let mut inherited = span
            .parent()
            .and_then(|p| p.extensions().get::<Inherited>().cloned())
            .unwrap_or_default();
        attrs.record(&mut inherited);
        span.extensions_mut().insert(inherited.clone());
        if inherited.0.is_empty() {
            return;
        }
        // Subscriber::record is a visitor interface: the OTel layer accepts these
        // centrally defined fields even when feature spans do not declare them.
        // Keep only a WeakDispatch to avoid a subscriber reference cycle. Recording
        // through the complete dispatch also makes the appender see inherited fields.
        static META: tracing::Metadata<'static> = tracing::metadata! {
            name: "inherited telemetry fields", target: "taphoa_api::telemetry",
            level: tracing::Level::INFO, fields: INHERITED,
            callsite: &CALLSITE, kind: tracing::metadata::Kind::SPAN,
        };
        static CALLSITE: tracing::callsite::DefaultCallsite =
            tracing::callsite::DefaultCallsite::new(&META);
        if let Some(dispatch) = self.dispatch.get().and_then(|d| d.upgrade()) {
            let values: Vec<_> = INHERITED
                .iter()
                .map(|key| {
                    inherited
                        .0
                        .get(key)
                        .map(|value| value as &dyn tracing::field::Value)
                })
                .collect();
            dispatch.record(id, &Record::new(&META.fields().value_set_all(&values)));
        }
    }
    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let mut extensions = span.extensions_mut();
            if let Some(inherited) = extensions.get_mut::<Inherited>() {
                values.record(inherited);
            }
        }
    }
}

pub fn record_identity(actor: &crate::auth::Actor) {
    let span = tracing::Span::current();
    span.record("taphoa.store.id", actor.store_id.to_string());
    span.record("taphoa.member.id", actor.member_id.to_string());
    span.record("taphoa.member.role", actor.role.as_str());
    span.record("session.id", actor.session_id.to_string());
    // Actor currently has no person id. The future Clerk mapping belongs here.
}

struct Headers<'a>(&'a axum::http::HeaderMap);
impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key)?.to_str().ok()
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}
#[derive(Clone)]
pub(crate) struct ErrorCode(pub &'static str);

pub async fn http_span(request: Request, next: Next) -> Response {
    let start = Instant::now();
    let method = request.method().as_str();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str);
    let name = route.map_or_else(|| method.to_owned(), |route| format!("{method} {route}"));
    let span = tracing::info_span!(
        "http request",
        otel.name = name,
        otel.kind = "server",
        http.request.method = method,
        http.route = tracing::field::Empty,
        url.path = tracing::field::Empty,
        http.response.status_code = tracing::field::Empty,
        taphoa.error.code = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        posthog.session_id = tracing::field::Empty,
        user.id = tracing::field::Empty,
        taphoa.store.id = tracing::field::Empty,
        taphoa.member.id = tracing::field::Empty,
        taphoa.member.role = tracing::field::Empty,
        session.id = tracing::field::Empty
    );
    // Unmatched paths are attacker-chosen: they can carry tokens and have unbounded
    // cardinality, so only matched requests record a path and route.
    if let Some(route) = route {
        span.record("http.route", route);
        span.record("url.path", request.uri().path());
    }
    if let Some(session) = request
        .headers()
        .get("x-posthog-session-id")
        .and_then(|v| v.to_str().ok())
    {
        span.record("posthog.session_id", session);
    }
    // Use the same W3C propagator in scoped tests without modifying globals.
    let parent = TraceContextPropagator::new().extract(&Headers(request.headers()));
    let _ = span.set_parent(parent);
    let route = route.unwrap_or("").to_owned();
    async move {
        let response = next.run(request).await;
        let span = tracing::Span::current();
        let status = response.status();
        span.record("http.response.status_code", i64::from(status.as_u16()));
        if let Some(code) = response.extensions().get::<ErrorCode>() {
            span.record("taphoa.error.code", code.0);
        }
        if status.is_server_error() {
            span.record("otel.status_code", "ERROR");
        }
        tracing::info!(
            http.route = route,
            http.response.status_code = status.as_u16(),
            duration_ms = start.elapsed().as_secs_f64() * 1000.0,
            "request completed"
        );
        response
    }
    .instrument(span)
    .await
}

/// Instrument an adapter future without recording arguments, keys or payloads.
pub async fn client<T, E>(
    name: &str,
    address: &str,
    work: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let span = tracing::info_span!(
        "client",
        otel.name = name,
        otel.kind = "client",
        server.address = address,
        taphoa.outcome = tracing::field::Empty
    );
    let mut outcome = Outcome::new(&span, "taphoa.outcome");
    async move {
        let result = work.await;
        outcome.finish(result.is_ok());
        result
    }
    .instrument(span)
    .await
}
pub async fn job<T, E>(
    name: &str,
    attempt: i64,
    work: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let span = job_span(name, attempt);
    let mut outcome = Outcome::new(&span, "taphoa.job.outcome");
    async move {
        let result = work.await;
        outcome.finish(result.is_ok());
        result
    }
    .instrument(span)
    .await
}

/// Record once, including when shutdown cancels an in-flight operation. Keeping a
/// span clone lets Drop record the outcome before the span is exported.
pub(crate) struct Outcome {
    span: tracing::Span,
    field: &'static str,
    finished: bool,
}
impl Outcome {
    pub(crate) fn new(span: &tracing::Span, field: &'static str) -> Self {
        Self {
            span: span.clone(),
            field,
            finished: false,
        }
    }
    pub(crate) fn finish(&mut self, ok: bool) {
        if !self.finished {
            self.span
                .record(self.field, if ok { "ok" } else { "error" });
            self.finished = true;
        }
    }
}
impl Drop for Outcome {
    fn drop(&mut self) {
        self.finish(false);
    }
}
pub fn job_span(name: &str, attempt: i64) -> tracing::Span {
    tracing::info_span!(
        "job",
        otel.name = format!("job {name}"),
        taphoa.job.name = name,
        taphoa.job.attempt = attempt,
        taphoa.job.outcome = tracing::field::Empty
    )
}
/// Extract the host only, stripping credentials, paths and query parameters.
pub fn server_address(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

struct SqlxLayer(SdkTracer);
#[derive(Default)]
struct Query {
    statement: String,
    summary: String,
    elapsed: f64,
}
impl Visit for Query {
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "db.statement" => self.statement = value.into(),
            "summary" => self.summary = value.into(),
            _ => {}
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        if field.name() == "elapsed_secs" {
            self.elapsed = value;
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // sqlx records statement and summary using tracing's Display wrapper.
        if matches!(field.name(), "db.statement" | "summary") {
            self.record_str(field, &format!("{value:?}"));
        }
    }
}
impl<S> Layer<S> for SqlxLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        if event.metadata().target() != SQLX_QUERY {
            return;
        }
        // Background pollers query outside any span; a db span there would be a root trace.
        let parent = opentelemetry::Context::current();
        if !parent.span().span_context().is_valid() {
            return;
        }
        let mut query = Query::default();
        event.record(&mut query);
        let sql = if query.statement.is_empty() {
            &query.summary
        } else {
            &query.statement
        };
        let (operation, table) = sql_name(sql);
        let mut attributes = vec![
            KeyValue::new("db.system.name", "postgresql"),
            KeyValue::new("db.operation.name", operation.clone()),
        ];
        if let Some(table) = &table {
            attributes.push(KeyValue::new("db.collection.name", table.clone()));
        }
        // Inherited is cumulative per span: the innermost span already holds every
        // ancestor's identity, and walking the whole scope would repeat each key.
        if let Some(span) = ctx.event_scope(event).and_then(|mut scope| scope.next())
            && let Some(inherited) = span.extensions().get::<Inherited>()
        {
            attributes.extend(
                inherited
                    .0
                    .iter()
                    .map(|(k, v)| KeyValue::new(*k, v.clone())),
            );
        }
        let now = SystemTime::now();
        let elapsed = Duration::try_from_secs_f64(query.elapsed).unwrap_or_default();
        let name = table.map_or_else(
            || format!("db {operation}"),
            |t| format!("db {operation} {t}"),
        );
        let mut span = self.0.build_with_context(
            self.0
                .span_builder(name)
                .with_kind(SpanKind::Client)
                .with_start_time(now.checked_sub(elapsed).unwrap_or(now))
                .with_attributes(attributes),
            &parent,
        );
        span.end_with_timestamp(now);
    }
}

/// Conservative SQL token scan: only operation and a validated identifier escape.
/// Unknown/complex statements omit the table; values and comments never become attributes.
fn sql_name(sql: &str) -> (String, Option<String>) {
    let mut clean = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '-' && chars.peek() == Some(&'-') {
            chars.next();
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            clean.push(' ');
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut depth = 1;
            while let Some(c) = chars.next() {
                if c == '/' && chars.peek() == Some(&'*') {
                    chars.next();
                    depth += 1;
                } else if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
            clean.push(' ');
        } else if c == '\'' {
            clean.push(' ');
            while let Some(c) = chars.next() {
                if c == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
            clean.push(' ');
        } else {
            clean.push(c);
        }
    }
    let separated = clean.replace('(', " ( ").replace(')', " ) ");
    let mut depth = 0_u32;
    let tokens: Vec<_> = separated
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | ';'))
        .filter(|s| !s.is_empty())
        .filter(|token| match *token {
            "(" => {
                depth += 1;
                depth == 1
            }
            ")" => {
                depth = depth.saturating_sub(1);
                false
            }
            _ => depth == 0,
        })
        .collect();
    let Some(first) = tokens.first() else {
        return ("QUERY".into(), None);
    };
    let op = first.to_ascii_uppercase();
    if !matches!(
        op.as_str(),
        "SELECT"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
            | "TRUNCATE"
            | "CREATE"
            | "ALTER"
            | "DROP"
            | "BEGIN"
            | "COMMIT"
            | "ROLLBACK"
            | "WITH"
    ) {
        return ("QUERY".into(), None);
    }
    // CTE table selection needs a full parser. Do not guess its main collection.
    if op == "WITH" {
        let operation = tokens
            .iter()
            .skip(1)
            .map(|t| t.to_ascii_uppercase())
            .find(|t| matches!(t.as_str(), "SELECT" | "INSERT" | "UPDATE" | "DELETE"))
            .unwrap_or_else(|| "QUERY".into());
        return (operation, None);
    }
    let complex_literals = sql
        .as_bytes()
        .windows(2)
        .any(|w| w[0] == b'$' && (w[1] == b'$' || w[1].is_ascii_alphabetic() || w[1] == b'_'))
        || sql.contains("\\'");
    if complex_literals {
        return (op, None);
    }
    let table = if op == "UPDATE" {
        tokens.get(1)
    } else {
        let marker = match op.as_str() {
            "SELECT" | "DELETE" => "FROM",
            "INSERT" => "INTO",
            "CREATE" | "ALTER" | "DROP" | "TRUNCATE" => "TABLE",
            _ => "",
        };
        tokens
            .iter()
            .position(|s| !marker.is_empty() && s.eq_ignore_ascii_case(marker))
            .and_then(|i| tokens.get(i + 1))
    }
    .map(|s| s.trim_matches('"'))
    .filter(|s| {
        !s.is_empty()
            && s.chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'))
            && !matches!(s.to_ascii_uppercase().as_str(), "SELECT" | "ONLY" | "IF")
    })
    .map(str::to_owned);
    (op, table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::{logs::InMemoryLogExporter, trace::InMemorySpanExporter};

    fn config_with_endpoint(endpoint: &str) -> TelemetryConfig {
        TelemetryConfig::from_lookup(
            |name| (name == "OTEL_EXPORTER_OTLP_ENDPOINT").then(|| endpoint.to_owned()),
            || None,
        )
    }

    // Only the failure path runs here: the endpoint is rejected before any HTTP client,
    // thread, TLS provider, subscriber or propagator is created.
    #[test]
    fn exporter_failure_disables_export_without_leaking_the_endpoint() {
        let config = config_with_endpoint("https://user:secret@bad host.example/");
        assert!(config.enabled());
        let (guard, failure) = export_guard(&config);
        assert!(guard.traces.is_none() && guard.logs.is_none());
        let failure = failure.expect("a failure message to log");
        assert!(failure.contains("invalid endpoint"), "{failure}");
        for leaked in ["user", "secret", "bad host"] {
            assert!(!failure.contains(leaked), "{leaked} leaked: {failure}");
        }
    }

    #[test]
    fn unconfigured_export_has_no_providers_and_no_failure() {
        let (guard, failure) = export_guard(&TelemetryConfig::from_lookup(|_| None, || None));
        assert!(guard.traces.is_none() && guard.logs.is_none() && failure.is_none());
    }

    #[test]
    fn subscriber_global_max_level_stays_at_debug_or_below() {
        use tracing::Subscriber as _;
        let guard = TelemetryGuard {
            traces: Some(
                SdkTracerProvider::builder()
                    .with_simple_exporter(InMemorySpanExporter::default())
                    .build(),
            ),
            logs: Some(
                SdkLoggerProvider::builder()
                    .with_simple_exporter(InMemoryLogExporter::default())
                    .build(),
            ),
        };
        let filter = || EnvFilter::new("taphoa_api=info,tower_http=info");
        for json in [false, true] {
            assert_eq!(
                subscriber(&guard, filter(), json).max_level_hint(),
                Some(LevelFilter::DEBUG),
                "json={json}"
            );
        }
        assert_eq!(
            subscriber(&TelemetryGuard::default(), filter(), false).max_level_hint(),
            Some(LevelFilter::INFO)
        );
    }

    #[test]
    fn sql_parser_never_uses_literals_or_comments_as_collection() {
        assert_eq!(
            sql_name("/* secret */ SELECT 'FROM password' FROM members WHERE token='secret'"),
            ("SELECT".into(), Some("members".into()))
        );
        assert_eq!(
            sql_name("INSERT INTO products(id) VALUES ('private')"),
            ("INSERT".into(), Some("products".into()))
        );
        assert_eq!(
            sql_name("UPDATE members SET name='secret'"),
            ("UPDATE".into(), Some("members".into()))
        );
        assert_eq!(sql_name("SELECT 1"), ("SELECT".into(), None));
        assert_eq!(
            sql_name("SELECT $$ private FROM sensitive $$"),
            ("SELECT".into(), None)
        );
        assert_eq!(
            sql_name("WITH x AS (SELECT * FROM private) SELECT * FROM x"),
            ("SELECT".into(), None)
        );
        assert_eq!(
            sql_name("SELECT (SELECT id FROM inner_table) FROM members"),
            ("SELECT".into(), Some("members".into()))
        );
        assert_eq!(
            sql_name("SELECT * FROM (SELECT * FROM members) derived"),
            ("SELECT".into(), None)
        );
        assert_eq!(
            sql_name("SELECT /* nested /* FROM private */ FROM secret */ id FROM members"),
            ("SELECT".into(), Some("members".into()))
        );
    }
}
