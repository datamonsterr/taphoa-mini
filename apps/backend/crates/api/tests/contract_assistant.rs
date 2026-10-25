//! Assistant contract samples only: no assistant handlers or external services.
mod common;
use axum::http::StatusCode;
use common::Contract;
use serde_json::{Value, json};

const ID: &str = "0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c01";
const AT: &str = "2026-10-25T08:00:00+07:00";
const THREADS: &str = "/v1/assistant/threads";
const THREAD: &str = "/v1/assistant/threads/{threadId}";
const STREAM: &str = "/v1/assistant/threads/{threadId}/messages";
const CONFIRM: &str = "/v1/assistant/actions/{actionId}/confirm";
const REJECT: &str = "/v1/assistant/actions/{actionId}/reject";
const FEEDBACK: &str = "/v1/assistant/messages/{messageId}/feedback";

fn thread() -> Value {
    json!({"id":ID,"title":null,"context":{"screen":"camera","next_step_id":"restock","receipt_id":ID,"image_id":ID},"created_at":AT,"updated_at":AT})
}
fn action() -> Value {
    json!({"id":ID,"thread_id":ID,"message_id":ID,"kind":"expense","status":"proposed","payload":{"amount":150000,"category":"dien","note":"Tiền điện","paid_with":"cash_box"},"summary_vi":"Ghi chi phí điện 150.000 ₫","proposed_by":ID,"decided_by":null,"decided_at":null,"result":null,"error":null,"expires_at":"2026-10-26T08:00:00+07:00","created_at":AT})
}
fn message() -> Value {
    json!({"id":ID,"thread_id":ID,"role":"assistant","content":"Cần nhập thêm Coca.","attachments":[],"tool_calls":[{"call_id":"call_1","tool":"get_restock_plan","ok":true,"summary_vi":"Có 1 mặt hàng sắp hết"}],"cards":[cards()[1].clone()],"model":"provider/model","feedback":null,"created_at":AT})
}
fn next_step() -> Value {
    json!({"id":"restock","kind":"restock","title_vi":"Nhập hàng","subtitle_vi":null,"priority":10,"action":{"type":"chat","prompt_vi":"Lên danh sách nhập hàng","context":{"screen":"camera","next_step_id":"restock"}}})
}
fn cards() -> Vec<Value> {
    vec![
        json!({"type":"receipt_lines","receipt_id":ID,"lines":[{"line_id":ID,"name":"Coca lon","quantity":24,"cost":204000,"product_id":ID,"product_name":"Coca-Cola lon","confidence":0.96}]}),
        json!({"type":"restock_list","items":[{"product_id":ID,"name":"Coca lon","quantity":24,"unit_cost":8500,"total_cost":204000}],"total_cost":204000}),
        json!({"type":"debt_list","items":[{"customer_id":ID,"name":"Cô Lan","total":120000,"overdue_days":8}]}),
        json!({"type":"chart_bars","title_vi":"Lợi nhuận","unit":"dong","bars":[{"label":"Hôm qua","value":-120000}]}),
    ]
}
#[test]
fn assistant_api_contract_table_is_complete() {
    let c = Contract::load();
    for (path, method, status) in [
        (THREADS, "post", "201"),
        (THREADS, "get", "200"),
        (THREAD, "get", "200"),
        (THREAD, "delete", "204"),
        (STREAM, "post", "200"),
        (CONFIRM, "post", "200"),
        (REJECT, "post", "200"),
        (FEEDBACK, "post", "204"),
        ("/v1/assistant/next-steps", "get", "200"),
        ("/v1/assistant/digest", "get", "200"),
        ("/v1/devices", "post", "200"),
        ("/v1/devices/{token}", "delete", "204"),
    ] {
        let op = c.operation(path, method);
        assert!(op["operationId"].is_string());
        assert!(
            op["responses"][status].is_object(),
            "{method} {path} {status}"
        );
        assert!(op["responses"]["401"].is_object(), "bearer auth required");
    }
    assert!(
        c.operation(CONFIRM, "post")["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["$ref"] == "#/components/parameters/IdempotencyKey")
    );
    for (path, names) in [
        (
            "/v1/assistant/next-steps",
            vec!["screen", "document_detected", "unknown_product"],
        ),
        ("/v1/assistant/digest", vec!["business_date"]),
    ] {
        let op = c.operation(path, "get");
        for name in names {
            assert!(
                op["parameters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["name"] == name && p["in"] == "query")
            );
        }
    }
}
#[test]
fn assistant_bodyless_responses_and_request_schemas_are_documented() {
    let c = Contract::load();
    for (path, method) in [
        (THREAD, "delete"),
        (FEEDBACK, "post"),
        ("/v1/devices/{token}", "delete"),
    ] {
        assert!(c.operation(path, method)["responses"]["204"]["content"].is_null());
    }
    for (path, schema) in [
        (THREADS, "CreateAssistantThread"),
        (STREAM, "SendAssistantMessage"),
        (FEEDBACK, "AssistantFeedback"),
        ("/v1/devices", "RegisterDevice"),
    ] {
        let request = &c.operation(path, "post")["requestBody"];
        assert_eq!(request["required"], json!(true));
        assert_eq!(
            request["content"]["application/json"]["schema"]["$ref"],
            json!(format!("#/components/schemas/{schema}"))
        );
    }
}
#[test]
fn assistant_thread_responses_match_contract() {
    let c = Contract::load();
    c.assert_conforms(THREADS, "post", StatusCode::CREATED, &thread());
    c.assert_conforms(
        THREADS,
        "get",
        StatusCode::OK,
        &json!({"items":[thread()],"next_cursor":null}),
    );
    let mut user_message = message();
    user_message["role"] = json!("user");
    user_message["content"] = json!("Xem hóa đơn này");
    user_message["attachments"] = json!([{"image_id":ID},{"receipt_id":ID}]);
    user_message["tool_calls"] = json!([]);
    user_message["cards"] = json!([]);
    user_message["model"] = Value::Null;
    c.assert_conforms(
        THREAD,
        "get",
        StatusCode::OK,
        &json!({"thread":thread(),"messages":[user_message,message()],"actions":[action()]}),
    );
    let mut missing_attachments = message();
    missing_attachments
        .as_object_mut()
        .unwrap()
        .remove("attachments");
    assert!(!c.schema_accepts("AssistantMessage", &missing_attachments));
    let mut missing_title = thread();
    missing_title.as_object_mut().unwrap().remove("title");
    assert!(!c.schema_accepts("AssistantThread", &missing_title));
}
#[test]
fn assistant_action_decision_responses_match_contract() {
    let c = Contract::load();
    let mut confirmed = action();
    confirmed["status"] = json!("done");
    confirmed["decided_by"] = json!(ID);
    confirmed["decided_at"] = json!(AT);
    confirmed["result"] = json!({"expense_id":ID});
    c.assert_conforms(CONFIRM, "post", StatusCode::OK, &confirmed);
    confirmed["status"] = json!("rejected");
    confirmed["result"] = Value::Null;
    c.assert_conforms(REJECT, "post", StatusCode::OK, &confirmed);
    for path in [CONFIRM, REJECT] {
        for code in ["action_stale", "already_decided"] {
            c.assert_conforms(
                path,
                "post",
                StatusCode::CONFLICT,
                &json!({"error":"Đề xuất đã được xử lý","code":code}),
            );
        }
    }
}
#[test]
fn assistant_next_steps_digest_and_device_responses_match_contract() {
    let c = Contract::load();
    c.assert_conforms("/v1/assistant/next-steps","get",StatusCode::OK,&json!({"items":[next_step(),{"id":"drafts","kind":"draft_receipts","title_vi":"Hóa đơn nháp","subtitle_vi":"2 hóa đơn","priority":20,"action":{"type":"navigate","route":"/receipts"}}]}));
    c.assert_conforms("/v1/assistant/digest","get",StatusCode::OK,&json!({"business_date":"2026-10-24","generated_at":AT,"source":"template","summary_vi":"Hôm qua bán được 1.200.000 ₫.","sales":{"revenue":1200000,"sale_count":25,"gross_profit":null,"change_pct":null},"restock":[{"product_id":ID,"name":"Coca lon","quantity":24,"unit_cost":8500,"total_cost":204000}],"overdue_debts":{"count":1,"total":120000},"open_drafts":{"count":2},"read_at":null}));
    c.assert_conforms("/v1/devices","post",StatusCode::OK,&json!({"token":"ExponentPushToken[example]","platform":"android","app_version":"1.0.0","language":"vi","created_at":AT,"updated_at":AT}));
}
#[test]
fn assistant_stream_accepts_all_eight_event_variants() {
    let c = Contract::load();
    for (event, data) in [
        ("message.created", json!({"message_id":ID,"thread_id":ID})),
        ("message.delta", json!({"text":"Xin chào"})),
        (
            "tool.started",
            json!({"call_id":"call_1","tool":"get_restock_plan","label_vi":"Đang kiểm tra tồn kho"}),
        ),
        (
            "tool.finished",
            json!({"call_id":"call_1","tool":"get_restock_plan","ok":true,"summary_vi":"1 mặt hàng sắp hết"}),
        ),
        ("action.proposed", action()),
        ("card", cards()[0].clone()),
        (
            "message.completed",
            json!({"message_id":ID,"model":"provider/model","usage":{"input_tokens":240,"output_tokens":36}}),
        ),
        (
            "error",
            json!({"code":"quota","message_vi":"Hôm nay đã hết lượt"}),
        ),
    ] {
        c.assert_stream_conforms(STREAM, &json!({"event":event,"data":data}));
    }
}
#[test]
fn assistant_stream_rejects_wrong_event_payload_and_missing_fields() {
    let c = Contract::load();
    for bad in [
        json!({"event":"message.created","data":{"text":"Xin chào"}}),
        json!({"event":"message.delta","data":{}}),
        json!({"event":"unknown","data":{"text":"x"}}),
        json!({"event":"error","data":{"code":"other","message_vi":"Lỗi"}}),
    ] {
        assert!(!c.schema_accepts("AssistantStreamEvent", &bad));
    }
    let mut bad = thread();
    bad.as_object_mut().unwrap().remove("id");
    assert!(!c.schema_accepts("AssistantThread", &bad));
    assert!(!c.schema_accepts("NextStepList", &json!({"items":vec![next_step();9]})));
    assert!(c.schema_accepts("NextStepList", &json!({"items":vec![next_step();8]})));
}
#[test]
fn assistant_cards_enforce_discriminators_and_integer_money() {
    let c = Contract::load();
    for card in cards() {
        assert!(c.schema_accepts("AssistantCard", &card), "{card}");
    }
    let mut chart = cards()[3].clone();
    chart["unit"] = json!("units");
    assert!(c.schema_accepts("AssistantCard", &chart));
    chart.as_object_mut().unwrap().remove("unit");
    assert!(!c.schema_accepts("AssistantCard", &chart));
    chart["unit"] = json!("percent");
    assert!(!c.schema_accepts("AssistantCard", &chart));
    chart["unit"] = json!("dong");
    chart["bars"][0]["value"] = json!(1.5);
    assert!(!c.schema_accepts("AssistantCard", &chart));
    let mut receipt = cards()[0].clone();
    receipt["lines"][0]["product_name"] = Value::Null;
    assert!(c.schema_accepts("AssistantCard", &receipt));
    receipt["lines"][0]
        .as_object_mut()
        .unwrap()
        .remove("product_name");
    assert!(!c.schema_accepts("AssistantCard", &receipt));
    let mut bad = cards()[1].clone();
    bad["total_cost"] = json!(20.5);
    assert!(!c.schema_accepts("AssistantCard", &bad));
    let mut bad = cards()[0].clone();
    bad["type"] = json!("debt_list");
    assert!(!c.schema_accepts("AssistantCard", &bad));
}
#[test]
fn assistant_inputs_enforce_content_attachments_language_and_feedback() {
    let c = Contract::load();
    assert!(c.schema_accepts("CreateAssistantThread", &json!({})));
    assert!(c.schema_accepts(
        "CreateAssistantThread",
        &json!({"title":"Nhập hàng","context":{"screen":"camera","receipt_id":ID}})
    ));
    for attachment in [json!({"image_id":ID}), json!({"receipt_id":ID})] {
        assert!(c.schema_accepts(
            "SendAssistantMessage",
            &json!({"content":"Xem hóa đơn này","language":"vi","attachments":[attachment]})
        ));
    }
    for bad in [
        json!({}),
        json!({"content":"","language":"vi"}),
        json!({"content":"x".repeat(4001),"language":"vi"}),
        json!({"content":"Hello","language":"fr"}),
        json!({"content":"Hello","language":"en","attachments":[{"image_id":ID,"receipt_id":ID}]}),
    ] {
        assert!(!c.schema_accepts("SendAssistantMessage", &bad));
    }
    assert!(c.schema_accepts(
        "SendAssistantMessage",
        &json!({"content":"x".repeat(4000),"language":"en"})
    ));
    assert!(c.schema_accepts(
        "AssistantFeedback",
        &json!({"rating":"down","comment":"Chưa đúng"})
    ));
    assert!(!c.schema_accepts("AssistantFeedback", &json!({"rating":"neutral"})));
    assert!(c.schema_accepts("RegisterDevice",&json!({"token":"ExponentPushToken[example]","platform":"ios","app_version":"1.0.0","language":"en"})));
    assert!(!c.schema_accepts(
        "RegisterDevice",
        &json!({"token":"x","platform":"web","app_version":"1.0.0","language":"vi"})
    ));
}
#[test]
fn assistant_action_kinds_and_statuses_follow_the_settled_lifecycle() {
    let c = Contract::load();
    for kind in [
        "stock_adjustment",
        "expense",
        "price_change",
        "threshold_update",
        "reorder_list",
        "receipt_line_update",
        "receipt_confirm",
        "repayment",
        "debt_adjustment",
        "invite",
    ] {
        let mut sample = action();
        sample["kind"] = json!(kind);
        assert!(c.schema_accepts("AssistantAction", &sample));
    }
    for status in [
        "proposed",
        "executing",
        "done",
        "failed",
        "rejected",
        "expired",
    ] {
        let mut sample = action();
        sample["status"] = json!(status);
        assert!(c.schema_accepts("AssistantAction", &sample));
    }
    for (field, value) in [("status", "confirmed"), ("kind", "propose_expense")] {
        let mut sample = action();
        sample[field] = json!(value);
        assert!(!c.schema_accepts("AssistantAction", &sample));
    }
    for kind in [
        "receipt_detected",
        "unknown_product",
        "restock",
        "draft_receipts",
        "overdue_debts",
        "day_close",
        "review_queue",
        "digest",
        "setup",
        "margin_alert",
    ] {
        let mut sample = next_step();
        sample["kind"] = json!(kind);
        assert!(c.schema_accepts("NextStep", &sample));
    }
}
