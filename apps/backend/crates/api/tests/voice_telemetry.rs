mod common;
use async_trait::async_trait;
use common::voice::{line, sale, setup, upload};
use opentelemetry::{Value as OtelValue, trace::SpanKind};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider,
    trace::{InMemorySpanExporter, SdkTracerProvider, SpanData},
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use taphoa_api::{
    analytics::{Analytics, CaptureEvent},
    telemetry,
    voice::{audio::fixtures, scripted::Step},
};
use tracing_subscriber::prelude::*;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct Recorder(Mutex<Vec<CaptureEvent>>);
#[async_trait]
impl Analytics for Recorder {
    async fn capture_event(&self, event: CaptureEvent) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}
impl Recorder {
    async fn events(&self, name: &str, count: usize) -> Vec<CaptureEvent> {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let found: Vec<_> = self
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e.event == name)
                    .cloned()
                    .collect();
                if found.len() >= count {
                    return found;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("missing {name} events"))
    }
}
fn attr(span: &SpanData, name: &str) -> Option<OtelValue> {
    span.attributes
        .iter()
        .find(|a| a.key.as_str() == name)
        .map(|a| a.value.clone())
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires Postgres"]
async fn utterance_span_model_call_spans_and_generation_events() {
    let _serial = SERIAL.lock().await;
    let spans = InMemorySpanExporter::default();
    let traces = SdkTracerProvider::builder()
        .with_simple_exporter(spans.clone())
        .build();
    let logs = SdkLoggerProvider::builder().build();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(telemetry::otel_layers(&traces, &logs)),
    );
    let parse = sale(
        "hai chai nước mắm Lan Anh 0912345678 và bia tiger mười lăm nghìn",
        vec![
            line("hai chai nước mắm", "nước mắm", Some(2.0), None, None, None),
            line(
                "bia tiger",
                "bia tiger",
                Some(1.0),
                None,
                Some(15000.0),
                Some("mười lăm nghìn"),
            ),
        ],
        "cash",
        None,
    );
    let (mut w, _) = setup(vec![Step::unavailable(), Step::parse(parse)], |_| {}).await;
    let recorder = Arc::new(Recorder::default());
    w.state.analytics = recorder.clone();
    w.app = taphoa_api::router(w.state.clone());
    w.product("Nước mắm Nam Ngư", 32000, None).await;
    let r = upload(&w, &fixtures::m4a(4.0, b"x"), "sale").await;
    assert_eq!(r.status, 201, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_owned();
    let _ = traces.force_flush();
    let finished = spans.get_finished_spans().unwrap();

    let utterance = finished
        .iter()
        .find(|s| s.name == "voice.utterance")
        .expect("voice.utterance span");
    assert_eq!(utterance.span_kind, SpanKind::Internal);
    assert_eq!(attr(utterance, "voice.mode"), Some("sale".into()));
    assert_eq!(attr(utterance, "voice.entry"), Some("chat".into()));
    assert_eq!(attr(utterance, "voice.model"), Some("g/two".into()));
    assert_eq!(attr(utterance, "voice.stt_fallback"), Some(false.into()));
    assert_eq!(attr(utterance, "voice.intent"), Some("sale".into()));
    assert_eq!(attr(utterance, "voice.lines"), Some(2i64.into()));
    assert_eq!(attr(utterance, "voice.matched"), Some(1i64.into()));
    assert_eq!(attr(utterance, "voice.ambiguous"), Some(0i64.into()));
    assert_eq!(attr(utterance, "voice.unknown"), Some(1i64.into()));
    assert!(attr(utterance, "voice.latency_ms").is_some());
    match attr(utterance, "voice.audio_seconds") {
        Some(OtelValue::F64(s)) => assert!((s - 4.0).abs() < 0.05),
        other => panic!("{other:?}"),
    }
    assert!(
        attr(utterance, "taphoa.store.id").is_some(),
        "identity attributes"
    );

    let calls: Vec<_> = finished
        .iter()
        .filter(|s| s.name == "voice.model_call")
        .collect();
    assert_eq!(calls.len(), 2, "one span per model call, failures included");
    for call in &calls {
        assert_eq!(call.span_kind, SpanKind::Client);
        assert_eq!(call.parent_span_id, utterance.span_context.span_id());
        assert_eq!(attr(call, "gen_ai.operation.name"), Some("chat".into()));
        assert_eq!(
            attr(call, "gen_ai.provider.name"),
            Some("openrouter".into())
        );
    }
    let failed = calls
        .iter()
        .find(|c| attr(c, "gen_ai.request.model") == Some("g/one".into()))
        .unwrap();
    assert_eq!(attr(failed, "error.type"), Some("unavailable".into()));
    let good = calls
        .iter()
        .find(|c| attr(c, "gen_ai.request.model") == Some("g/two".into()))
        .unwrap();
    assert_eq!(attr(good, "gen_ai.usage.input_tokens"), Some(300i64.into()));
    assert_eq!(attr(good, "gen_ai.usage.output_tokens"), Some(80i64.into()));
    assert_eq!(
        attr(good, "taphoa.assistant.fallback_index"),
        Some(1i64.into())
    );

    // No transcript or customer words in any attribute of any span.
    for span in &finished {
        for a in &span.attributes {
            let text = format!("{:?}", a.value);
            assert!(
                !text.contains("Lan Anh")
                    && !text.contains("0912345678")
                    && !text.contains("nước mắm"),
                "{}: {text}",
                a.key
            );
        }
    }

    let generations = recorder.events("$ai_generation", 2).await;
    assert_eq!(generations.len(), 2);
    for g in &generations {
        assert_eq!(g.properties["$ai_session_id"], json!(id));
        assert_eq!(g.properties["$ai_provider"], "openrouter");
        assert!(
            g.properties.get("$ai_input").is_none()
                && g.properties.get("$ai_output_choices").is_none()
        );
        let text = serde_json::to_string(&g.properties).unwrap();
        assert!(!text.contains("Lan Anh") && !text.contains("0912345678"));
    }
    let ok = generations
        .iter()
        .find(|g| g.properties["$ai_model"] == "g/two")
        .unwrap();
    assert_eq!(ok.properties["$ai_input_tokens"], 300);
    assert_eq!(ok.properties["$ai_output_tokens"], 80);
    assert_eq!(ok.properties["$ai_total_cost_usd"], 0.0002);
    assert_eq!(ok.properties["$ai_is_error"], false);
    let bad = generations
        .iter()
        .find(|g| g.properties["$ai_model"] == "g/one")
        .unwrap();
    assert_eq!(bad.properties["$ai_is_error"], true);

    let drafted = recorder.events("voice_sale_drafted", 1).await;
    let p = &drafted[0].properties;
    assert_eq!(
        (
            p["lines"].as_u64(),
            p["matched"].as_u64(),
            p["unknown"].as_u64()
        ),
        (Some(2), Some(1), Some(1))
    );
    assert_eq!(p["stt_fallback"], false);
}
