mod common;
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use common::world::World;
use opentelemetry::{Value as OtelValue, trace::SpanKind};
use opentelemetry_sdk::{
    logs::{InMemoryLogExporter, SdkLoggerProvider},
    trace::{InMemorySpanExporter, SdkTracerProvider, SpanData},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use taphoa_api::{
    analytics::{Analytics, CaptureEvent},
    assistant::{
        config::AssistantConfig,
        model::{
            ModelError,
            scripted::{ScriptedModel, Step},
        },
        tools::{Registry, Tool, ToolContext, ToolError, ToolKind, ToolOutput},
    },
    router, telemetry,
};
use tower::ServiceExt;
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
                let events: Vec<_> = self
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e.event == name)
                    .cloned()
                    .collect();
                if events.len() >= count {
                    return events;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("missing {name} events"))
    }
}
struct Capture {
    spans: InMemorySpanExporter,
    traces: SdkTracerProvider,
    logs: SdkLoggerProvider,
}
impl Capture {
    fn new() -> Self {
        let spans = InMemorySpanExporter::default();
        let traces = SdkTracerProvider::builder()
            .with_simple_exporter(spans.clone())
            .build();
        let logs = SdkLoggerProvider::builder()
            .with_simple_exporter(InMemoryLogExporter::default())
            .build();
        Self {
            spans,
            traces,
            logs,
        }
    }
    fn subscriber(&self) -> impl tracing::Subscriber + use<> {
        tracing_subscriber::registry().with(telemetry::otel_layers(&self.traces, &self.logs))
    }
}
fn attr(span: &SpanData, name: &str) -> Option<OtelValue> {
    span.attributes
        .iter()
        .find(|a| a.key.as_str() == name)
        .map(|a| a.value.clone())
}
struct ReadTool;
#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &'static str {
        "get_sales_summary"
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        "Công cụ thử"
    }
    fn parameters(&self) -> Value {
        json!({"type":"object"})
    }
    fn requires(&self) -> Option<taphoa_api::auth::Action> {
        None
    }
    fn label_vi(&self) -> &'static str {
        "Đang thử"
    }
    async fn run(&self, ctx: &ToolContext, _: Value) -> Result<ToolOutput, ToolError> {
        sqlx::query("SELECT id FROM stores WHERE id=$1")
            .bind(ctx.actor.store_id)
            .execute(ctx.state.postgres.as_ref().unwrap())
            .await?;
        let mut output = ToolOutput::new(
            json!({"rows":[{"private":"ROW_SECRET","phone":"0912345678"}]}),
            "Tổng 12345678, gọi 0912345678",
        );
        output.rows = 1;
        Ok(output)
    }
}
async fn setup(steps: Vec<Step>, survey: bool, cap: u32) -> (World, Arc<Recorder>) {
    let mut w = World::new().await;
    let recorder = Arc::new(Recorder::default());
    w.state.analytics = recorder.clone();
    w.state.assistant.config = Arc::new(AssistantConfig {
        models: vec!["first/m:free".into(), "second/m:free".into()],
        allow_eval_headers: true,
        daily_messages_per_store: cap,
        feedback_survey_id: survey.then(|| "survey".into()),
        feedback_question_id: survey.then(|| "rating".into()),
        feedback_comment_question_id: survey.then(|| "comment".into()),
        ..AssistantConfig::default()
    });
    w.state.assistant.model = Some(Arc::new(ScriptedModel::new(steps)));
    let mut tools = taphoa_api::assistant::tools::all();
    tools.retain(|t| t.name() != "get_sales_summary");
    tools.push(Arc::new(ReadTool));
    w.state.assistant.registry = Arc::new(Registry::new(tools));
    w.state.redis = None;
    taphoa_api::assistant::quota::clear_openrouter_exhausted(&w.state).await;
    w.app = router(w.state.clone());
    (w, recorder)
}
async fn thread(w: &World, seller: bool) -> String {
    let r = w
        .call(
            "POST",
            "/v1/assistant/threads",
            if seller { &w.seller } else { &w.lead },
            json!({"context":{"screen":"stock","next_step_id":"low_stock:example"}}),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.body);
    r.body["id"].as_str().unwrap().into()
}
async fn turn(w: &World, id: &str, seller: bool, eval: bool) -> String {
    let mut req = Request::post(format!("/v1/assistant/threads/{id}/messages"))
        .header(
            "authorization",
            format!("Bearer {}", if seller { &w.seller } else { &w.lead }),
        )
        .header("content-type", "application/json");
    if eval {
        req = req
            .header("X-Taphoa-Eval-Run", "telemetry-test")
            .header("X-Taphoa-Today", "2026-02-17");
    }
    let r=w.app.clone().oneshot(req.body(Body::from(json!({"content":"Gọi 0912345678, bank 1234567890123, giá 1.234.000 và 12345678","language":"vi"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(r.status(), 200);
    String::from_utf8(to_bytes(r.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
}
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires Postgres"]
async fn turn_spans_events_fallback_denial_eval_and_masking() {
    let _serial = SERIAL.lock().await;
    let capture = Capture::new();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let (w, recorder) = setup(
        vec![
            Step::error(ModelError::RateLimited {
                status: 429,
                message: "retry".into(),
            }),
            Step::tools([
                (
                    "propose_price_change",
                    json!({"product_id":"12345678-1234-1234-1234-123456789abc","new_price":1000}),
                ),
                (
                    "get_sales_summary",
                    json!({"nested":{"phone":"0912345678"}}),
                ),
            ]),
            Step::text("Đã gọi 0912345678"),
        ],
        false,
        60,
    )
    .await;
    let id = thread(&w, true).await;
    assert!(turn(&w, &id, true, true).await.contains("second/m:free"));
    let traces = recorder.events("$ai_trace", 1).await;
    let generations = recorder.events("$ai_generation", 3).await;
    let tools = recorder.events("$ai_span", 2).await;
    assert_eq!((traces.len(), generations.len(), tools.len()), (1, 3, 2));
    let spans = capture.spans.get_finished_spans().unwrap();
    let invoke = spans
        .iter()
        .find(|s| s.name == "invoke_agent taphoa-assistant")
        .expect("invoke span");
    assert_eq!(invoke.span_kind, SpanKind::Internal);
    for (key, value) in [
        ("gen_ai.operation.name", "invoke_agent"),
        ("gen_ai.conversation.id", id.as_str()),
        ("taphoa.assistant.screen", "stock"),
    ] {
        assert_eq!(attr(invoke, key), Some(value.to_owned().into()));
    }
    assert_eq!(
        attr(invoke, "taphoa.member.id"),
        Some(w.seller_id.to_string().into())
    );
    assert_eq!(
        traces[0].properties["$ai_trace_id"],
        invoke.span_context.trace_id().to_string()
    );
    let chats: Vec<_> = spans
        .iter()
        .filter(|s| s.name.starts_with("chat "))
        .collect();
    assert_eq!(chats.len(), 3);
    assert!(
        chats.iter().all(|s| s.span_kind == SpanKind::Client
            && s.parent_span_id == invoke.span_context.span_id())
    );
    assert!(
        chats
            .iter()
            .any(|s| attr(s, "taphoa.assistant.fallback_index") == Some(1_i64.into()))
    );
    assert!(chats.iter().any(|s| attr(s, "error.type").is_some()));
    let tool = spans
        .iter()
        .find(|s| s.name == "execute_tool propose_price_change")
        .unwrap();
    assert_eq!(attr(tool, "taphoa.tool.denied"), Some(true.into()));
    assert_eq!(attr(tool, "taphoa.tool.ok"), Some(false.into()));
    assert_eq!(tool.parent_span_id, invoke.span_context.span_id());
    let read = spans
        .iter()
        .find(|s| s.name == "execute_tool get_sales_summary")
        .unwrap();
    assert_eq!(attr(read, "taphoa.tool.kind"), Some("read".into()));
    assert_eq!(attr(read, "taphoa.tool.rows"), Some(1_i64.into()));
    assert!(
        spans.iter().any(
            |s| s.name == "db SELECT stores" && s.parent_span_id == read.span_context.span_id()
        )
    );
    let request_span = spans
        .iter()
        .find(|s| s.name == "POST /v1/assistant/threads/{thread_id}/messages");
    let request_span = request_span
        .or_else(|| {
            spans.iter().find(|s| {
                s.span_kind == SpanKind::Server && s.span_context.span_id() == invoke.parent_span_id
            })
        })
        .unwrap();
    assert_eq!(invoke.parent_span_id, request_span.span_context.span_id());
    for span in &chats {
        for key in [
            "gen_ai.operation.name",
            "gen_ai.provider.name",
            "gen_ai.request.model",
            "gen_ai.response.model",
            "gen_ai.usage.input_tokens",
            "gen_ai.usage.output_tokens",
            "server.address",
        ] {
            assert!(attr(span, key).is_some(), "{key}");
        }
    }
    assert!(
        chats
            .iter()
            .any(|s| attr(s, "gen_ai.response.finish_reasons").is_some())
    );
    assert!(
        chats
            .iter()
            .any(|s| attr(s, "taphoa.assistant.time_to_first_token_ms").is_some())
    );
    assert!(
        traces[0].properties["use_cases"]
            .as_array()
            .unwrap()
            .contains(&json!("U2"))
    );
    assert!(
        attr(invoke, "taphoa.assistant.use_cases")
            .unwrap()
            .as_str()
            .contains("U2")
    );
    for e in traces.iter().chain(&generations).chain(&tools) {
        assert_eq!(e.distinct_id, w.seller_id.to_string());
        assert_eq!(e.groups["store"], w.store_id.to_string());
        for (key, value) in [
            ("environment", "eval"),
            ("eval_run_id", "telemetry-test"),
            ("$ai_session_id", id.as_str()),
        ] {
            assert_eq!(e.properties[key], value);
        }
        let props = serde_json::to_string(&e.properties).unwrap();
        assert!(!props.contains("0912345678") && !props.contains("1234567890123"));
    }
    assert_eq!(traces[0].properties["entry"], "chip");
    assert!(
        traces[0].properties["$ai_input_state"]
            .as_str()
            .unwrap()
            .contains("1.234.000 và 12345678")
    );
    assert!(
        traces[0].properties["$ai_output_state"]
            .as_str()
            .unwrap()
            .contains("[số]")
    );
    assert_eq!(generations[1].properties["fallback_index"], 1);
    assert_eq!(generations[0].properties["$ai_http_status"], 429);
    assert_eq!(generations[0].properties["$ai_is_error"], true);
    for g in &generations {
        for key in [
            "$ai_span_id",
            "$ai_parent_id",
            "$ai_input",
            "$ai_output_choices",
            "$ai_tools",
            "$ai_stop_reason",
            "$ai_time_to_first_token",
        ] {
            assert!(g.properties.contains_key(key), "{key}");
        }
        for key in [
            "$ai_input_cost_usd",
            "$ai_output_cost_usd",
            "$ai_total_cost_usd",
        ] {
            assert_eq!(g.properties[key], 0);
        }
    }
    assert_eq!(generations[2].properties["$ai_model"], "second/m:free");
    assert!(
        generations[2].properties["$ai_input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool")
    );
    assert_eq!(tools[0].properties["$ai_output_state"]["ok"], false);
    assert_eq!(tools[1].properties["$ai_output_state"]["rows"], 1);
    assert_eq!(tools[1].properties["$ai_output_state"]["ok"], true);
    assert!(
        !tools[1].properties["$ai_output_state"]
            .to_string()
            .contains("ROW_SECRET")
    );
    for event in &generations {
        assert!(
            chats
                .iter()
                .any(|s| s.span_context.span_id().to_string() == event.properties["$ai_span_id"])
        );
    }
    assert_eq!(
        tools[1].properties["$ai_span_id"],
        read.span_context.span_id().to_string()
    );
    for span in spans {
        let attrs = format!("{:?}", span.attributes);
        assert!(
            !attrs.contains("0912345678")
                && !attrs.contains("Đã gọi")
                && !attrs.contains("new_price")
        );
    }
}
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires Postgres"]
async fn proposals_decisions_links_feedback_and_quota() {
    let _serial = SERIAL.lock().await;
    let capture = Capture::new();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let (mut w, recorder) = setup(
        vec![
            Step::tool(
                "propose_expense",
                json!({"amount":1000,"category":"khac","paid_with":"cash_box","note":"thử"}),
            ),
            Step::text("Xong"),
        ],
        true,
        1,
    )
    .await;
    let id = thread(&w, false).await;
    turn(&w, &id, false, false).await;
    let trace = recorder.events("$ai_trace", 1).await.remove(0);
    let proposed = recorder
        .events("assistant_action_proposed", 1)
        .await
        .remove(0);
    assert_eq!(
        proposed.properties["$ai_trace_id"],
        trace.properties["$ai_trace_id"]
    );
    let (action, message, span_id): (uuid::Uuid, uuid::Uuid, Option<String>) =
        sqlx::query_as("SELECT id,message_id,span_id FROM assistant_actions WHERE thread_id=$1")
            .bind(id.parse::<uuid::Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert!(span_id.is_some());
    let stored: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT trace_id,span_id FROM assistant_messages WHERE id=$1")
            .bind(message)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(
        stored.0.as_deref(),
        trace.properties["$ai_trace_id"].as_str()
    );
    assert_eq!(stored.1, span_id);

    let path = format!("/v1/assistant/actions/{action}/reject");
    assert_eq!(
        w.call("POST", &path, &w.lead, json!(null)).await.status,
        200
    );
    assert_eq!(
        w.call("POST", &path, &w.lead, json!(null)).await.status,
        409
    );
    let decisions = recorder.events("assistant_action_decided", 1).await;
    assert_eq!(decisions.len(), 1);
    assert_eq!(
        decisions[0].properties["$ai_trace_id"],
        trace.properties["$ai_trace_id"]
    );
    assert_eq!(decisions[0].properties["decision"], "rejected");
    let spans = capture.spans.get_finished_spans().unwrap();
    let decision = spans
        .iter()
        .find(|s| s.name == "assistant.action expense")
        .unwrap();
    assert_eq!(
        attr(decision, "taphoa.action.status"),
        Some("rejected".into())
    );
    assert_eq!(decision.links.links.len(), 1);
    assert_eq!(
        decision.links.links[0].span_context.trace_id().to_string(),
        trace.properties["$ai_trace_id"]
    );
    assert_eq!(
        decision.links.links[0].span_context.span_id().to_string(),
        span_id.unwrap()
    );
    let path = format!("/v1/assistant/messages/{message}/feedback");
    assert_eq!(
        w.call(
            "POST",
            &path,
            &w.lead,
            json!({"rating":"down","comment":"Gọi 0912345678"})
        )
        .await
        .status,
        204
    );
    let survey = recorder.events("survey sent", 1).await.remove(0);
    assert_eq!(survey.properties["$survey_response_rating"], 2);
    assert_eq!(survey.properties["$survey_completed"], true);
    assert_eq!(survey.properties["$survey_response_comment"], "Gọi [số]");
    assert_eq!(
        survey.properties["$ai_trace_id"],
        trace.properties["$ai_trace_id"]
    );
    assert!(
        uuid::Uuid::parse_str(survey.properties["$survey_submission_id"].as_str().unwrap()).is_ok()
    );
    assert_eq!(
        recorder.events("assistant_feedback_submitted", 1).await[0].properties["comment"],
        "Gọi [số]"
    );
    Arc::make_mut(&mut w.state.assistant.config).feedback_survey_id = None;
    w.app = router(w.state.clone());
    w.call("POST", &path, &w.lead, json!({"rating":"up"})).await;
    assert_eq!(
        recorder
            .events("assistant_feedback_submitted", 2)
            .await
            .len(),
        2
    );
    assert_eq!(recorder.events("survey sent", 1).await.len(), 1);
    turn(&w, &id, false, false).await;
    assert_eq!(
        recorder.events("assistant_quota_hit", 1).await[0].properties["scope"],
        "store"
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires Postgres"]
async fn openrouter_quota_reports_scope_and_trace_without_exporter() {
    let _serial = SERIAL.lock().await;
    let (w, recorder) = setup(
        vec![Step::error(ModelError::DailyQuota {
            message: "daily quota reached".into(),
        })],
        false,
        60,
    )
    .await;
    let id = thread(&w, false).await;
    assert!(turn(&w, &id, false, false).await.contains("quota"));
    let first = recorder.events("assistant_quota_hit", 1).await;
    assert_eq!(first[0].properties["scope"], "openrouter");
    let trace = recorder.events("$ai_trace", 1).await;
    assert_eq!(
        first[0].properties["$ai_trace_id"],
        trace[0].properties["$ai_trace_id"]
    );
    let trace_id = trace[0].properties["$ai_trace_id"].as_str().unwrap();
    assert_eq!(trace_id.len(), 32);
    assert!(trace_id.bytes().all(|c| c.is_ascii_hexdigit()));
    turn(&w, &id, false, false).await;
    assert_eq!(
        recorder.events("assistant_quota_hit", 2).await[1].properties["scope"],
        "openrouter"
    );
    assert_eq!(recorder.events("$ai_generation", 1).await.len(), 1);
    taphoa_api::assistant::quota::clear_openrouter_exhausted(&w.state).await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires Postgres"]
async fn action_confirm_replay_expiry_failure_and_legacy_rows() {
    let _serial = SERIAL.lock().await;
    let capture = Capture::new();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let (w, recorder) = setup(vec![], false, 60).await;
    let id = thread(&w, false).await;
    let message:uuid::Uuid=sqlx::query_scalar("INSERT INTO assistant_messages(thread_id,store_id,role,content) VALUES($1,$2,'assistant','test') RETURNING id").bind(id.parse::<uuid::Uuid>().unwrap()).bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    for (kind, payload, status) in [
        (
            "expense",
            json!({"amount":1000,"category":"khac","paid_with":"cash_box"}),
            "confirmed",
        ),
        (
            "expense",
            json!({"amount":-1,"category":"khac","paid_with":"cash_box"}),
            "failed",
        ),
        ("reorder_list", json!({"items":[]}), "expired"),
    ] {
        let action:uuid::Uuid=sqlx::query_scalar("INSERT INTO assistant_actions(store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,trace_id,expires_at) VALUES($1,$2,$3,$4,$5,'test',$6,$7,now()+($8::int * interval '1 hour')) RETURNING id").bind(w.store_id).bind(id.parse::<uuid::Uuid>().unwrap()).bind(message).bind(kind).bind(payload).bind(w.lead_id).bind("abcdefabcdefabcdefabcdefabcdefab").bind(if status=="expired"{-1}else{24}).fetch_one(w.pool()).await.unwrap();
        let request = || {
            Request::post(format!("/v1/assistant/actions/{action}/confirm"))
                .header("authorization", format!("Bearer {}", w.lead))
                .header("idempotency-key", action.to_string())
                .body(Body::empty())
                .unwrap()
        };
        let r = w.app.clone().oneshot(request()).await.unwrap();
        assert_eq!(
            r.status().as_u16(),
            if status == "expired" { 409 } else { 200 }
        );
        let _ = to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let r = w.app.clone().oneshot(request()).await.unwrap();
        assert_eq!(
            r.status().as_u16(),
            if status == "expired" { 409 } else { 200 }
        );
        let _ = to_bytes(r.into_body(), 1 << 20).await.unwrap();
    }
    let events = recorder.events("assistant_action_decided", 3).await;
    assert_eq!(events.len(), 3);
    let spans = capture.spans.get_finished_spans().unwrap();
    for status in ["confirmed", "expired", "failed"] {
        assert!(events.iter().any(|e| e.properties["decision"] == status));
        assert!(
            spans
                .iter()
                .any(|s| attr(s, "taphoa.action.status") == Some(status.into())
                    && s.links.links.is_empty())
        );
    }
}
