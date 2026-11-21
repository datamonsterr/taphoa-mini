use super::*;
use crate::telemetry::{TelemetryConfig, TelemetryGuard, build_providers};
use opentelemetry::{
    Value,
    logs::Severity,
    trace::{Span as _, Tracer as _, TracerProvider as _},
};
use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceRequest, trace::v1::ExportTraceServiceRequest,
};
use opentelemetry_sdk::{logs::InMemoryLogExporter, trace::InMemorySpanExporter};
use prost::Message;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Instant, SystemTime},
};

#[derive(serde::Deserialize)]
struct Cases {
    blocked_keys: Vec<String>,
    allowed_attributes: HashMap<String, String>,
    string_bodies: Vec<(String, String)>,
}
fn cases() -> Cases {
    // Also consumed by the real collector's Python routing tests.
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../infra/otel-collector/tests/redaction-cases.json"
    )))
    .unwrap()
}
fn attributes() -> Vec<KeyValue> {
    let cases = cases();
    cases
        .blocked_keys
        .into_iter()
        .map(|key| KeyValue::new(key, "must-disappear"))
        .chain(
            cases
                .allowed_attributes
                .into_iter()
                .map(|(key, value)| KeyValue::new(key, value)),
        )
        .collect()
}
fn assert_attributes(actual: HashMap<String, String>) {
    assert_eq!(actual, cases().allowed_attributes);
}

#[test]
fn sdk_spans_redact_before_the_inner_exporter() {
    let capture = InMemorySpanExporter::default();
    let provider = opentelemetry_sdk::trace::SdkTracerProvider::builder()
        .with_simple_exporter(Traces(capture.clone()))
        .build();
    let tracer = provider.tracer("taphoa.assistant");
    let mut parent = tracer.start("agent");
    parent.set_attributes(attributes());
    parent.end();
    let spans = capture.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name, "agent");
    assert_attributes(
        spans[0]
            .attributes
            .iter()
            .map(|kv| (kv.key.to_string(), kv.value.to_string()))
            .collect(),
    );
}

#[test]
fn sdk_logs_redact_and_preserve_body_types_context_and_metadata() {
    let capture = InMemoryLogExporter::default();
    let provider = SdkLoggerProvider::builder()
        .with_resource(
            Resource::builder_empty()
                .with_attributes(attributes())
                .build(),
        )
        .with_simple_exporter(Logs::new(capture.clone()))
        .build();
    let logger = provider.logger("taphoa.logs");
    let timestamp = SystemTime::UNIX_EPOCH + Duration::from_secs(42);
    for body in cases()
        .string_bodies
        .iter()
        .map(|(body, _)| AnyValue::String(body.clone().into()))
        .chain([
            AnyValue::Int(42),
            AnyValue::ListAny(Box::new(vec![AnyValue::Int(123456789)])),
        ])
    {
        let mut record = logger.create_log_record();
        record.set_body(body);
        record.set_event_name("event");
        record.set_target("target");
        record.set_timestamp(timestamp);
        record.set_observed_timestamp(timestamp);
        record.set_severity_text("WARN");
        record.set_severity_number(Severity::Warn);
        record.set_trace_context(
            opentelemetry::TraceId::from(1),
            opentelemetry::SpanId::from(2),
            Some(opentelemetry::TraceFlags::SAMPLED),
        );
        record.add_attributes(
            attributes()
                .into_iter()
                .map(|kv| (kv.key, AnyValue::String(kv.value.to_string().into()))),
        );
        logger.emit(record);
    }
    let logs = capture.get_emitted_logs().unwrap();
    let expected: Vec<_> = cases()
        .string_bodies
        .into_iter()
        .map(|(_, body)| AnyValue::String(body.into()))
        .chain([
            AnyValue::Int(42),
            AnyValue::ListAny(Box::new(vec![AnyValue::Int(123456789)])),
        ])
        .collect();
    assert_eq!(logs.len(), expected.len());
    for (log, body) in logs.iter().zip(expected) {
        let record = &log.record;
        assert_eq!(record.body(), Some(&body));
        assert_attributes(
            record
                .attributes_iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        match v {
                            AnyValue::String(s) => s.to_string(),
                            _ => panic!("string attribute"),
                        },
                    )
                })
                .collect(),
        );
        assert_eq!(record.event_name(), Some("event"));
        assert_eq!(record.target().unwrap(), "target");
        assert_eq!(record.timestamp(), Some(timestamp));
        assert_eq!(record.observed_timestamp(), Some(timestamp));
        assert_eq!(record.severity_text(), Some("WARN"));
        assert_eq!(record.severity_number(), Some(Severity::Warn));
        let context = record.trace_context().unwrap();
        assert_eq!(context.trace_id, opentelemetry::TraceId::from(1));
        assert_eq!(context.span_id, opentelemetry::SpanId::from(2));
        assert_eq!(
            context.trace_flags,
            Some(opentelemetry::TraceFlags::SAMPLED)
        );
        assert_eq!(log.instrumentation.name(), "taphoa.logs");
        assert_eq!(
            log.resource.get(&Key::from(ENVIRONMENT)),
            Some(Value::from("unknown"))
        );
        for key in cases().blocked_keys {
            assert!(log.resource.get(&Key::from(key)).is_none());
        }
    }
}

#[derive(Debug)]
struct ResourceCapture(Arc<Mutex<Option<Resource>>>);
impl SpanExporter for ResourceCapture {
    async fn export(&self, _: Vec<SpanData>) -> OTelSdkResult {
        Ok(())
    }
    fn set_resource(&mut self, resource: &Resource) {
        *self.0.lock().unwrap() = Some(resource.clone());
    }
}
#[test]
fn both_exporters_sanitize_resources_insert_only_missing_environment_and_keep_schema() {
    for environment in [None, Some("production"), Some("test"), Some("")] {
        let mut attrs = attributes();
        if let Some(environment) = environment {
            attrs.push(KeyValue::new(ENVIRONMENT, environment));
        }
        let resource = Resource::builder_empty()
            .with_schema_url(attrs, "https://example.com/schema")
            .build();
        let trace_resource = Arc::new(Mutex::new(None));
        let mut traces = Traces(ResourceCapture(trace_resource.clone()));
        traces.set_resource(&resource);
        let logs = InMemoryLogExporter::default();
        let provider = SdkLoggerProvider::builder()
            .with_resource(resource)
            .with_simple_exporter(Logs::new(logs.clone()))
            .build();
        let logger = provider.logger("test");
        logger.emit(logger.create_log_record());
        let records = logs.get_emitted_logs().unwrap();
        for resource in [
            trace_resource.lock().unwrap().clone().unwrap(),
            records[0].resource.as_ref().clone(),
        ] {
            assert_eq!(resource.schema_url(), Some("https://example.com/schema"));
            assert_eq!(
                resource.get(&Key::from(ENVIRONMENT)),
                Some(Value::from(environment.unwrap_or("unknown")))
            );
            assert_attributes(
                resource
                    .iter()
                    .filter(|(key, _)| key.as_str() != ENVIRONMENT)
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            );
        }
    }
}

// A child test process exercises actual OTEL_* env parsing without mutating the
// environment underneath concurrent tests. It only exports to the parent's loopback sink.
#[test]
fn http_export_child() {
    if std::env::var("A4_HTTP_CHILD").as_deref() != Ok("1") {
        return;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (traces, logs) = build_providers(&TelemetryConfig::from_env()).unwrap();
    let mut span = traces.tracer("taphoa.assistant").start("agent");
    span.set_attributes(attributes());
    span.end();
    let logger = logs.logger("taphoa.logs");
    let mut record = logger.create_log_record();
    record.set_body(AnyValue::String("account 123456789012 end".into()));
    record.add_attributes(
        attributes()
            .into_iter()
            .map(|kv| (kv.key, AnyValue::String(kv.value.to_string().into()))),
    );
    logger.emit(record);
    // A permanent failure is not requeued when shutdown follows a failed flush.
    if std::env::var("A4_PERMANENT").as_deref() == Ok("1") {
        let _ = traces.force_flush();
        let _ = logs.force_flush();
    }
    // Otherwise no force_flush: shutdown must deliver both queued signals itself.
    TelemetryGuard {
        traces: Some(traces),
        logs: Some(logs),
    }
    .shutdown();
}

struct Request {
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}
fn receive(stream: &mut TcpStream) -> Request {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("POST "), "{line}");
    let path = line.split_whitespace().nth(1).unwrap().to_owned();
    let mut headers = HashMap::new();
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        let (key, value) = line.split_once(':').unwrap();
        headers.insert(key.to_ascii_lowercase(), value.trim().to_owned());
    }
    let mut body = vec![0; headers["content-length"].parse().unwrap()];
    reader.read_exact(&mut body).unwrap();
    Request {
        path,
        headers,
        body,
    }
}

#[test]
fn http_protobuf_base_paths_bearer_redaction_retry_and_shutdown_flush() {
    for (prefix, failure, count) in [
        ("", "503 Service Unavailable", 4),
        ("/i", "503 Service Unavailable", 4),
        ("/i", "400 Bad Request", 2),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}{prefix}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut attempts = HashMap::<String, usize>::new();
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = receive(&mut stream);
                        let attempt = attempts.entry(request.path.clone()).or_default();
                        *attempt += 1;
                        let status = if *attempt == 1 || count == 2 {
                            failure
                        } else {
                            "200 OK"
                        };
                        stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
                        tx.send(request).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "telemetry::redaction::tests::http_export_child",
            "--nocapture",
        ]);
        for (key, _) in
            std::env::vars_os().filter(|(key, _)| key.to_string_lossy().starts_with("OTEL_"))
        {
            command.env_remove(key);
        }
        let start = Instant::now();
        let output = command
            .env("A4_HTTP_CHILD", "1")
            .env("A4_PERMANENT", if count == 2 { "1" } else { "0" })
            .env("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)
            .env("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer x")
            .env("TELEMETRY_ENVIRONMENT", "test")
            .output()
            .unwrap();
        stop.store(true, Ordering::Relaxed);
        server.join().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(start.elapsed() < Duration::from_secs(6));
        let requests: Vec<_> = rx.into_iter().collect();
        assert_eq!(requests.len(), count, "bounded retry or permanent drop");
        for signal in ["traces", "logs"] {
            let path = format!("{prefix}/v1/{signal}");
            let matching: Vec<_> = requests.iter().filter(|r| r.path == path).collect();
            assert_eq!(matching.len(), count / 2);
            if count == 4 {
                assert_eq!(matching[0].body, matching[1].body);
            }
            for request in matching {
                assert_eq!(request.headers["authorization"], "Bearer x");
                assert_eq!(request.headers["content-type"], "application/x-protobuf");
                assert!(!String::from_utf8_lossy(&request.body).contains("must-disappear"));
                if signal == "traces" {
                    let data = ExportTraceServiceRequest::decode(request.body.as_slice()).unwrap();
                    assert_eq!(data.resource_spans.len(), 1);
                    let resource = &data.resource_spans[0];
                    assert!(format!("{:?}", resource.resource).contains("test"));
                    assert_eq!(resource.scope_spans[0].spans[0].name, "agent");
                } else {
                    let data = ExportLogsServiceRequest::decode(request.body.as_slice()).unwrap();
                    assert_eq!(data.resource_logs.len(), 1);
                    let resource = &data.resource_logs[0];
                    assert!(format!("{:?}", resource.resource).contains("test"));
                    let body = &resource.scope_logs[0].log_records[0].body;
                    assert!(format!("{body:?}").contains("account [REDACTED] end"));
                    assert!(!format!("{data:?}").contains("123456789012"));
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
struct StalledExporter {
    started: mpsc::Sender<()>,
    release: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
impl StalledExporter {
    fn stall(&self) {
        self.started.send(()).unwrap();
        let (lock, wake) = &*self.release;
        drop(
            wake.wait_while(lock.lock().unwrap(), |released| !*released)
                .unwrap(),
        );
    }
}
impl SpanExporter for StalledExporter {
    async fn export(&self, _: Vec<SpanData>) -> OTelSdkResult {
        self.stall();
        Ok(())
    }
}
impl LogExporter for StalledExporter {
    async fn export(&self, _: LogBatch<'_>) -> OTelSdkResult {
        self.stall();
        Ok(())
    }
}
#[test]
fn shutdown_bounds_both_signals_even_when_exports_stall() {
    use opentelemetry_sdk::{
        logs::{BatchConfigBuilder as LogConfig, BatchLogProcessor},
        trace::{BatchConfigBuilder as TraceConfig, BatchSpanProcessor, SdkTracerProvider},
    };
    let (tx, rx) = mpsc::channel();
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let exporter = StalledExporter {
        started: tx,
        release: release.clone(),
    };
    let traces = SdkTracerProvider::builder()
        .with_span_processor(
            BatchSpanProcessor::builder(Traces(exporter.clone()))
                .with_batch_config(TraceConfig::default().with_max_export_batch_size(1).build())
                .build(),
        )
        .build();
    let logs = SdkLoggerProvider::builder()
        .with_log_processor(
            BatchLogProcessor::builder(Logs::new(exporter))
                .with_batch_config(LogConfig::default().with_max_export_batch_size(1).build())
                .build(),
        )
        .build();
    traces.tracer("test").start("stall").end();
    let logger = logs.logger("test");
    logger.emit(logger.create_log_record());
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    TelemetryGuard {
        traces: Some(traces),
        logs: Some(logs),
    }
    .shutdown();
    let elapsed = start.elapsed();
    // Release workers after the assertion's measured interval; no threads are left stuck.
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    assert!(
        elapsed < Duration::from_secs(6),
        "shutdown took {elapsed:?}"
    );
}
