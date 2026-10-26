//! Deterministic e2e provider over real tools, SSE and action confirmation.
mod common;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::{Contract, world::World};
use serde_json::{Value, json};
use std::sync::Arc;
use taphoa_api::assistant::{
    config::{AssistantConfig, ModelProvider},
    model::{ChatMessage, ChatModel, ChatRequest, ChatResponse, rules::RuleModel},
    tools::Registry,
};
use tower::ServiceExt;
use uuid::Uuid;

const STREAM: &str = "/v1/assistant/threads/{threadId}/messages";
const HELLO: &str = "Xin chào! Mình là trợ lý của cửa hàng.";
const DENIED: &str = "Bạn không có quyền dùng công cụ này.";

fn request(text: &str) -> ChatRequest {
    ChatRequest {
        model: "scripted".into(),
        messages: vec![ChatMessage::user(text)],
        tools: Registry::standard()
            .for_actor(&taphoa_api::auth::Actor {
                store_id: Uuid::nil(),
                member_id: Uuid::nil(),
                session_id: Uuid::nil(),
                role: taphoa_api::auth::Role::Lead,
                can_enroll: true,
            })
            .iter()
            .map(|t| taphoa_api::assistant::model::ToolSpec {
                name: t.name().into(),
                description: t.description_vi().into(),
                parameters: t.parameters(),
            })
            .collect(),
        max_tokens: 512,
        reasoning_effort: None,
        tool_choice: None,
    }
}
async fn chat(req: &ChatRequest) -> ChatResponse {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let response = RuleModel.chat(req, &tx).await.unwrap();
    drop(tx);
    let mut chunks = vec![];
    while let Some(chunk) = rx.recv().await {
        chunks.push(chunk);
    }
    assert_eq!(chunks.concat(), response.content);
    if !response.content.is_empty() {
        assert!((2..=3).contains(&chunks.len()));
    }
    assert_eq!(response.model, "scripted");
    response
}
#[tokio::test]
async fn triggers_are_accent_insensitive_ordered_and_use_latest_user() {
    for text in [
        "nhập hàng",
        "NHAP HANG",
        "nha\u{0323}\u{0302}p ha\u{0300}ng",
        "nhập hàng rồi điều chỉnh",
    ] {
        assert_eq!(
            chat(&request(text)).await.tool_calls[0].name,
            "get_restock_plan"
        );
    }
    for text in ["điều chỉnh", "DIEU CHINH", "ĐiỀu ChỈnH"] {
        let r = chat(&request(text)).await;
        assert_eq!(r.tool_calls[0].name, "get_stock_levels");
        assert_eq!(
            serde_json::from_str::<Value>(&r.tool_calls[0].arguments).unwrap(),
            json!({"filter":"all"})
        );
        assert_eq!(r.tool_calls[0].id, "rule_1");
    }
    let mut req = request("nhập hàng");
    req.messages.push(ChatMessage::user("chào"));
    let r = chat(&req).await;
    assert!(r.tool_calls.is_empty());
    assert_eq!(r.content, HELLO);
    let id = Uuid::new_v4();
    for system in [true, false] {
        let mut req = request("nhập hàng điều chỉnh");
        let marker = format!("[đính kèm hóa đơn {id}] (receipt_id)");
        if system {
            req.messages.insert(0, ChatMessage::system(marker));
        } else {
            req.messages[0] = ChatMessage::user(format!("nhập hàng\n{marker}"));
        }
        let r = chat(&req).await;
        assert_eq!(r.tool_calls[0].name, "get_receipt");
        assert_eq!(
            serde_json::from_str::<Value>(&r.tool_calls[0].arguments).unwrap(),
            json!({"receipt_id":id})
        );
    }
}
#[tokio::test]
async fn missing_tools_deny_without_calls_and_tool_errors_end_safely() {
    for (text, missing) in [
        ("nhập hàng", "get_restock_plan"),
        ("điều chỉnh", "propose_stock_adjustment"),
    ] {
        let mut req = request(text);
        req.tools.retain(|t| t.name != missing);
        let r = chat(&req).await;
        assert!(r.tool_calls.is_empty());
        assert_eq!(r.content, DENIED);
    }
    let mut req = request("nhập hàng");
    let first = chat(&req).await;
    req.messages
        .push(ChatMessage::assistant(None, first.tool_calls));
    req.messages.push(ChatMessage::tool(
        "rule_1",
        r#"{"error":"not_found","message":"Không tìm thấy công cụ hoặc dữ liệu."}"#,
    ));
    let r = chat(&req).await;
    assert!(r.tool_calls.is_empty());
    assert!(r.content.contains("Không tìm thấy"));
}
#[tokio::test]
async fn results_supply_ids_and_quantities_without_becoming_instructions() {
    let product = Uuid::new_v4();
    let returned_receipt = Uuid::new_v4();
    let marker_receipt = Uuid::new_v4();
    for (text, data, name, args) in [
        (
            "nhập hàng".to_owned(),
            json!({"items":[{"product_id":product,"suggested_quantity":7,"name":"điều chỉnh"}]}),
            "propose_reorder_list",
            json!({"items":[{"product_id":product,"quantity":7}]}),
        ),
        (
            "điều chỉnh".to_owned(),
            json!({"items":[{"product_id":Uuid::new_v4(),"stock_quantity":null},{"product_id":product,"stock_quantity":0}]}),
            "propose_stock_adjustment",
            json!({"product_id":product,"delta":1,"reason":"Điều chỉnh thử từ trợ lý"}),
        ),
        (
            format!("[đính kèm hóa đơn {marker_receipt}] (receipt_id)"),
            json!({"receipt_id":returned_receipt,"lines":[]}),
            "propose_receipt_confirm",
            json!({"receipt_id":returned_receipt}),
        ),
    ] {
        let mut req = request(&text);
        let first = chat(&req).await;
        req.messages
            .push(ChatMessage::assistant(None, first.tool_calls));
        req.messages
            .push(ChatMessage::tool("rule_1", data.to_string()));
        let r = chat(&req).await;
        assert_eq!(r, chat(&req).await);
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].name, name);
        assert_eq!(r.tool_calls[0].id, "rule_2");
        assert_eq!(
            serde_json::from_str::<Value>(&r.tool_calls[0].arguments).unwrap(),
            args
        );
        req.messages
            .push(ChatMessage::assistant(Some(r.content), r.tool_calls));
        req.messages.push(ChatMessage::tool(
            "rule_2",
            json!({"action_id":Uuid::new_v4(),"note":"Chờ chủ cửa hàng bấm Xác nhận"}).to_string(),
        ));
        assert!(chat(&req).await.tool_calls.is_empty());
    }
    let mut req = request("điều chỉnh");
    let first = chat(&req).await;
    req.messages
        .push(ChatMessage::assistant(None, first.tool_calls));
    req.messages.push(ChatMessage::tool(
        "rule_1",
        r#"{"items":[{"product_id":"ignored","stock_quantity":null}]}"#,
    ));
    assert!(chat(&req).await.tool_calls.is_empty());
}
#[test]
fn scripted_configuration_is_safe_and_reports_the_provider_model() {
    let config = |env: &str| {
        AssistantConfig::from_lookup(|key| match key {
            "ASSISTANT_MODEL_PROVIDER" => Some("scripted".into()),
            "RAILWAY_ENVIRONMENT_NAME" => Some(env.into()),
            _ => None,
        })
    };
    assert_eq!(config("test").unwrap().models, ["scripted"]);
    assert_eq!(
        config("test").unwrap().model_provider,
        ModelProvider::Scripted
    );
    assert!(
        config("production")
            .unwrap_err()
            .to_string()
            .contains("production")
    );
}

async fn world() -> (World, Uuid, Uuid) {
    let mut w = World::new().await;
    w.state.assistant.config = Arc::new(
        AssistantConfig::from_lookup(|key| {
            (key == "ASSISTANT_MODEL_PROVIDER").then(|| "scripted".into())
        })
        .unwrap(),
    );
    w.state.assistant.model = Some(Arc::new(RuleModel));
    w.app = taphoa_api::router(w.state.clone());
    let product = w.product("Sữa", 15000, Some(10000)).await;
    sqlx::query("UPDATE products SET stock_quantity=2,low_stock_threshold=5 WHERE id=$1")
        .bind(product)
        .execute(w.pool())
        .await
        .unwrap();
    let image = Uuid::now_v7();
    let receipt = Uuid::now_v7();
    sqlx::query("INSERT INTO images(id,store_id,object_key,content_type,byte_size,purpose) VALUES($1,$2,$3,'image/jpeg',10,'checkout')").bind(image).bind(w.store_id).bind(format!("images/test/{image}.jpg")).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO receipts(id,store_id,member_id,image_id,ocr_text,parser,request_hash,total) VALUES($1,$2,$3,$4,'OCR','fallback','\\x00',20000)").bind(receipt).bind(w.store_id).bind(w.lead_id).bind(image).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO receipt_lines(receipt_id,store_id,position,raw_text,product_name,quantity,cost,product_id) VALUES($1,$2,0,'OCR','Sữa',2,10000,$3)").bind(receipt).bind(w.store_id).bind(product).execute(w.pool()).await.unwrap();
    (w, product, receipt)
}
async fn thread(w: &World, seller: bool, context: Value) -> String {
    let reply = w
        .call(
            "POST",
            "/v1/assistant/threads",
            if seller { &w.seller } else { &w.lead },
            json!({"context":context}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body["id"].as_str().unwrap().into()
}
async fn turn(
    w: &World,
    thread: &str,
    seller: bool,
    content: &str,
    attachments: Value,
) -> Vec<Value> {
    let reply = w
        .call(
            "POST",
            &format!("/v1/assistant/threads/{thread}/messages"),
            if seller { &w.seller } else { &w.lead },
            json!({"content":content,"language":"vi","attachments":attachments}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert!(
        reply.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let contract = Contract::load();
    let frames: Vec<Value> = std::str::from_utf8(&reply.raw)
        .unwrap()
        .split("\n\n")
        .filter(|f| !f.is_empty())
        .map(|f| {
            let mut lines = f.lines();
            let event = lines.next().unwrap().strip_prefix("event: ").unwrap();
            let data: Value =
                serde_json::from_str(lines.next().unwrap().strip_prefix("data: ").unwrap())
                    .unwrap();
            assert!(lines.next().is_none());
            let frame = json!({"event":event,"data":data});
            contract.assert_stream_conforms(STREAM, &frame);
            frame
        })
        .collect();
    assert_eq!(frames.first().unwrap()["event"], "message.created");
    assert_eq!(frames.last().unwrap()["event"], "message.completed");
    assert_eq!(frames.last().unwrap()["data"]["model"], "scripted");
    assert!(frames.iter().all(|f| f["event"] != "error"));
    frames
}
fn text(frames: &[Value]) -> String {
    frames
        .iter()
        .filter(|f| f["event"] == "message.delta")
        .map(|f| f["data"]["text"].as_str().unwrap())
        .collect()
}
fn assert_tools(frames: &[Value], names: &[&str]) {
    let started: Vec<_> = frames
        .iter()
        .filter(|f| f["event"] == "tool.started")
        .collect();
    assert_eq!(
        started
            .iter()
            .map(|f| f["data"]["tool"].as_str().unwrap())
            .collect::<Vec<_>>(),
        names
    );
    for (i, start) in started.iter().enumerate() {
        assert_eq!(start["data"]["call_id"], format!("rule_{}", i + 1));
        let finish = frames
            .iter()
            .position(|f| {
                f["event"] == "tool.finished" && f["data"]["call_id"] == start["data"]["call_id"]
            })
            .unwrap();
        assert_eq!(frames[finish]["data"]["ok"], true);
        assert!(frames.iter().position(|f| f == *start).unwrap() < finish);
    }
}
fn assert_flow(frames: &[Value], read_card: bool, propose_card: bool) {
    let mut expected = vec!["message.created", "tool.started"];
    if read_card {
        expected.push("card");
    }
    expected.extend([
        "tool.finished",
        "message.delta",
        "tool.started",
        "action.proposed",
    ]);
    if propose_card {
        expected.push("card");
    }
    expected.extend(["tool.finished", "message.delta", "message.completed"]);
    let mut actual = Vec::new();
    for frame in frames {
        let event = frame["event"].as_str().unwrap();
        if event != "message.delta" || actual.last() != Some(&event) {
            actual.push(event);
        }
    }
    assert_eq!(actual, expected);
}
async fn confirm(w: &World, frames: &[Value], kind: &str) -> Value {
    let action = &frames
        .iter()
        .find(|f| f["event"] == "action.proposed")
        .unwrap()["data"];
    assert_eq!(action["kind"], kind);
    assert_eq!(
        frames
            .iter()
            .filter(|f| f["event"] == "action.proposed")
            .count(),
        1
    );
    let response = w
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/assistant/actions/{}/confirm",
                    action["id"].as_str().unwrap()
                ))
                .header("authorization", format!("Bearer {}", w.lead))
                .header("idempotency-key", Uuid::new_v4().to_string())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8 << 20).await.unwrap()).unwrap();
    Contract::load().assert_conforms(
        "/v1/assistant/actions/{actionId}/confirm",
        "post",
        StatusCode::OK,
        &body,
    );
    assert_eq!(body["status"], "done", "{body}");
    body
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn receipt_context_and_attachment_take_precedence_and_confirm_real_receipts() {
    for attachment in [false, true] {
        let (w, product, receipt) = world().await;
        let id = thread(
            &w,
            false,
            if attachment {
                Value::Null
            } else {
                json!({"screen":"chat","receipt_id":receipt})
            },
        )
        .await;
        let f = turn(
            &w,
            &id,
            false,
            "nhập hàng điều chỉnh",
            if attachment {
                json!([{"receipt_id":receipt}])
            } else {
                json!([])
            },
        )
        .await;
        assert_tools(&f, &["get_receipt", "propose_receipt_confirm"]);
        assert_flow(&f, true, false);
        assert!(
            f.iter()
                .any(|f| f["event"] == "card" && f["data"]["type"] == "receipt_lines")
        );
        assert!(
            text(&f).contains("Mình đã đọc hóa đơn. Bạn kiểm tra các dòng rồi bấm Xác nhận nhé.")
        );
        let action = confirm(&w, &f, "receipt_confirm").await;
        assert_eq!(action["payload"]["receipt_id"], receipt.to_string());
        let stock: Option<i32> =
            sqlx::query_scalar("SELECT stock_quantity FROM products WHERE id=$1")
                .bind(product)
                .fetch_one(w.pool())
                .await
                .unwrap();
        assert_eq!(stock, Some(4));
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn restock_uses_plan_quantities_and_repeat_turns_start_fresh() {
    let (w, product, _) = world().await;
    let id = thread(&w, false, Value::Null).await;
    for _ in 0..2 {
        let f = turn(&w, &id, false, "nhap hang", json!([])).await;
        assert_tools(&f, &["get_restock_plan", "propose_reorder_list"]);
        assert_flow(&f, true, true);
        assert!(text(&f).contains("1 sản phẩm"));
        let first_card = &f.iter().find(|f| f["event"] == "card").unwrap()["data"];
        assert_eq!(first_card["type"], "restock_list");
        let action = confirm(&w, &f, "reorder_list").await;
        assert_eq!(
            action["payload"]["items"][0]["product_id"],
            product.to_string()
        );
        assert_eq!(
            action["payload"]["items"][0]["quantity"],
            first_card["items"][0]["quantity"]
        );
    }
    sqlx::query("UPDATE products SET stock_quantity=100 WHERE id=$1")
        .bind(product)
        .execute(w.pool())
        .await
        .unwrap();
    let f = turn(&w, &id, false, "nhập hàng", json!([])).await;
    assert_tools(&f, &["get_restock_plan"]);
    assert!(text(&f).contains("0 sản phẩm"));
    assert!(!f.iter().any(|f| f["event"] == "action.proposed"));
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn adjustment_uses_first_tracked_product_and_confirms() {
    let (w, product, _) = world().await;
    w.product("Không theo dõi", 1000, None).await;
    let id = thread(&w, false, Value::Null).await;
    let f = turn(&w, &id, false, "điều chỉnh", json!([])).await;
    assert_tools(&f, &["get_stock_levels", "propose_stock_adjustment"]);
    assert_flow(&f, false, false);
    let action = confirm(&w, &f, "stock_adjustment").await;
    assert_eq!(action["payload"]["product_id"], product.to_string());
    assert_eq!(action["payload"]["delta"], 1);
    assert_eq!(action["payload"]["reason"], "Điều chỉnh thử từ trợ lý");
    let stock: Option<i32> = sqlx::query_scalar("SELECT stock_quantity FROM products WHERE id=$1")
        .bind(product)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(stock, Some(3));
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn seller_is_denied_and_fallback_never_uses_tools() {
    let (w, _, _) = world().await;
    for (seller, content, expected) in [(true, "điều chỉnh", DENIED), (false, "xin chào", HELLO)]
    {
        let id = thread(&w, seller, Value::Null).await;
        let f = turn(&w, &id, seller, content, json!([])).await;
        assert_tools(&f, &[]);
        assert_eq!(text(&f), expected);
        assert!(
            !f.iter()
                .any(|f| f["event"] == "action.proposed" || f["event"] == "card")
        );
    }
}
