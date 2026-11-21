//! Final SDK export boundary, shared by collector and direct PostHog routes.
use opentelemetry::{
    Key, KeyValue,
    logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _, Severity},
};
use opentelemetry_sdk::{
    Resource,
    error::OTelSdkResult,
    logs::{LogBatch, LogExporter, SdkLogRecord, SdkLoggerProvider},
    trace::{SpanData, SpanExporter},
};
use regex::Regex;
use std::{sync::LazyLock, time::Duration};

// Rule table mirrors infra/otel-collector/config.yaml transform/redact and
// resource/defaults. Keep the two equal until the collector is deleted.
// No allowlist: unmatching keys/values pass through; events/links/scopes are untouched.
const BLOCKED_KEYS: &str =
    r"(?i)^(http[.]request[.]header[.]authorization|.*cookie.*|(.+[.])?(token|secret))$";
const LOG_DIGITS: &str = r"[0-9]{9,15}";
const MASK: &str = "[REDACTED]";
const ENVIRONMENT: &str = "deployment.environment.name";
const DEFAULT_ENVIRONMENT: &str = "unknown";
static KEYS: LazyLock<Regex> = LazyLock::new(|| Regex::new(BLOCKED_KEYS).expect("static key rule"));
static DIGITS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(LOG_DIGITS).expect("static body rule"));

fn resource(input: &Resource) -> Resource {
    let mut attributes: Vec<_> = input
        .iter()
        .filter(|(key, _)| !KEYS.is_match(key.as_str()))
        .map(|(key, value)| KeyValue::new(key.clone(), value.clone()))
        .collect();
    if input.get(&Key::from_static_str(ENVIRONMENT)).is_none() {
        attributes.push(KeyValue::new(ENVIRONMENT, DEFAULT_ENVIRONMENT));
    }
    let builder = Resource::builder_empty();
    match input.schema_url() {
        Some(url) => builder.with_schema_url(attributes, url.to_owned()).build(),
        None => builder.with_attributes(attributes).build(),
    }
}

#[derive(Debug)]
pub(super) struct Traces<E>(pub E);
impl<E: SpanExporter> SpanExporter for Traces<E> {
    async fn export(&self, mut batch: Vec<SpanData>) -> OTelSdkResult {
        for span in &mut batch {
            span.attributes.retain(|kv| !KEYS.is_match(kv.key.as_str()));
        }
        self.0.export(batch).await
    }
    fn set_resource(&mut self, input: &Resource) {
        self.0.set_resource(&resource(input));
    }
    fn force_flush(&self) -> OTelSdkResult {
        self.0.force_flush()
    }
    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.0.shutdown_with_timeout(timeout)
    }
}

#[derive(Debug)]
pub(super) struct Logs<E> {
    inner: E,
    empty: SdkLogRecord,
}
impl<E> Logs<E> {
    pub(super) fn new(inner: E) -> Self {
        // SDK 0.33.1 has no public constructor or attribute removal API. Create one
        // empty template (no processors/threads/export), then use public setters to
        // preserve every record field while copying only permitted attributes.
        let empty = SdkLoggerProvider::builder()
            .build()
            .logger("redaction-template")
            .create_log_record();
        Self { inner, empty }
    }
    fn record(&self, input: &SdkLogRecord) -> SdkLogRecord {
        let mut output = self.empty.clone();
        if let Some(value) = input.event_name() {
            output.set_event_name(value);
        }
        if let Some(value) = input.target() {
            output.set_target(value.clone());
        }
        if let Some(value) = input.timestamp() {
            output.set_timestamp(value);
        }
        if let Some(value) = input.observed_timestamp() {
            output.set_observed_timestamp(value);
        }
        if let Some(value) = input.severity_text() {
            output.set_severity_text(value);
        }
        if let Some(value) = input.severity_number() {
            output.set_severity_number(value);
        }
        if let Some(value) = input.trace_context() {
            output.set_trace_context(value.trace_id, value.span_id, value.trace_flags);
        }
        if let Some(value) = input.body() {
            output.set_body(match value {
                AnyValue::String(text) => {
                    AnyValue::String(DIGITS.replace_all(text.as_str(), MASK).into_owned().into())
                }
                value => value.clone(),
            });
        }
        output.add_attributes(
            input
                .attributes_iter()
                .filter(|(key, _)| !KEYS.is_match(key.as_str()))
                .cloned(),
        );
        output
    }
}
impl<E: LogExporter> LogExporter for Logs<E> {
    async fn export(&self, batch: LogBatch<'_>) -> OTelSdkResult {
        let records: Vec<_> = batch
            .iter()
            .map(|(record, scope)| (self.record(record), scope))
            .collect();
        let refs: Vec<_> = records
            .iter()
            .map(|(record, scope)| (record, *scope))
            .collect();
        self.inner.export(LogBatch::new(&refs)).await
    }
    fn set_resource(&mut self, input: &Resource) {
        self.inner.set_resource(&resource(input));
    }
    fn event_enabled(&self, level: Severity, target: &str, name: Option<&str>) -> bool {
        self.inner.event_enabled(level, target, name)
    }
    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }
}

#[cfg(test)]
mod tests;
