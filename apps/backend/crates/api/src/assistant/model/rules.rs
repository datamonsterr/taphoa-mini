//! Stateless local/e2e provider. Only the current turn's real tool results advance the script.
use super::{
    ChatMessage, ChatModel, ChatRequest, ChatResponse, ChatRole, ModelError, ToolCall, Usage,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::time::Duration;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use uuid::Uuid;

#[derive(Debug, Default)]
pub struct RuleModel;

const DENIED: &str = "Bạn không có quyền dùng công cụ này.";
const HELLO: &str = "Xin chào! Mình là trợ lý của cửa hàng.";
const DONE: &str = "Đã đề xuất. Bạn bấm Xác nhận để tiếp tục nhé.";

#[derive(Clone, Copy)]
enum Trigger {
    Receipt(Uuid),
    Restock,
    Adjustment,
}
impl Trigger {
    fn tools(self) -> (&'static str, &'static str) {
        match self {
            Self::Receipt(_) => ("get_receipt", "propose_receipt_confirm"),
            Self::Restock => ("get_restock_plan", "propose_reorder_list"),
            Self::Adjustment => ("get_stock_levels", "propose_stock_adjustment"),
        }
    }
    fn read_args(self) -> Value {
        match self {
            Self::Receipt(id) => json!({"receipt_id":id}),
            Self::Restock => json!({}),
            Self::Adjustment => json!({"filter":"all"}),
        }
    }
}
fn normalized(text: &str) -> String {
    text.to_lowercase()
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .map(|c| if c == 'đ' { 'd' } else { c })
        .collect()
}
fn receipt_marker(text: &str) -> Option<Uuid> {
    text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("[đính kèm hóa đơn ")?
            .strip_suffix("] (receipt_id)")?
            .parse()
            .ok()
    })
}
fn trigger(request: &ChatRequest, user: &ChatMessage) -> Option<Trigger> {
    let text = user.content.as_deref().unwrap_or_default();
    // Context markers are written by render_prompt; attachment markers by user_text.
    if let Some(id) = request
        .messages
        .iter()
        .filter(|m| m.role == ChatRole::System)
        .filter_map(|m| m.content.as_deref())
        .find_map(receipt_marker)
        .or_else(|| receipt_marker(text))
    {
        return Some(Trigger::Receipt(id));
    }
    let text = normalized(text);
    if text.contains("nhap hang") {
        Some(Trigger::Restock)
    } else if text.contains("dieu chinh") {
        Some(Trigger::Adjustment)
    } else {
        None
    }
}
fn result(messages: &[ChatMessage], name: &str) -> Option<Value> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| {
            if message.role != ChatRole::Tool {
                return None;
            }
            let id = message.tool_call_id.as_deref()?;
            let call = messages[..index]
                .iter()
                .rev()
                .flat_map(|m| &m.tool_calls)
                .find(|call| call.id == id)?;
            if call.name != name {
                return None;
            }
            serde_json::from_str(message.content.as_deref()?).ok()
        })
}
fn call(name: &str, number: usize, args: Value) -> ToolCall {
    ToolCall {
        id: format!("rule_{number}"),
        name: name.into(),
        arguments: args.to_string(),
    }
}
fn next(request: &ChatRequest) -> (String, Vec<ToolCall>) {
    let Some(user_index) = request
        .messages
        .iter()
        .rposition(|m| m.role == ChatRole::User)
    else {
        return (HELLO.into(), vec![]);
    };
    let Some(trigger) = trigger(request, &request.messages[user_index]) else {
        return (HELLO.into(), vec![]);
    };
    let (read, propose) = trigger.tools();
    if [read, propose]
        .iter()
        .any(|name| !request.tools.iter().any(|tool| tool.name == *name))
    {
        return (DENIED.into(), vec![]);
    }
    // Stable ids are reused across turns, so history before the latest user cannot advance us.
    let messages = &request.messages[user_index + 1..];
    if let Some(data) = result(messages, propose) {
        return (format!("\n\n{}", tool_error(&data).unwrap_or(DONE)), vec![]);
    }
    let Some(data) = result(messages, read) else {
        return (String::new(), vec![call(read, 1, trigger.read_args())]);
    };
    if let Some(error) = tool_error(&data) {
        return (error.into(), vec![]);
    }
    let (text, args) = match trigger {
        Trigger::Receipt(_) => {
            let Some(id) = data["receipt_id"]
                .as_str()
                .and_then(|s| s.parse::<Uuid>().ok())
            else {
                return ("Không tìm thấy hóa đơn.".into(), vec![]);
            };
            (
                "Mình đã đọc hóa đơn. Bạn kiểm tra các dòng rồi bấm Xác nhận nhé.".into(),
                json!({"receipt_id":id}),
            )
        }
        Trigger::Restock => {
            let items: Vec<Value> = data["items"].as_array().into_iter().flatten()
                .map(|item| json!({"product_id":item["product_id"],"quantity":item["suggested_quantity"]}))
                .collect();
            let text = format!("Có {} sản phẩm cần nhập hàng.", items.len());
            if items.is_empty() {
                return (text, vec![]);
            }
            (text, json!({"items":items}))
        }
        Trigger::Adjustment => {
            let Some(item) = data["items"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|item| item["stock_quantity"].as_i64().is_some())
            else {
                return (
                    "Không có sản phẩm đang theo dõi tồn kho để điều chỉnh.".into(),
                    vec![],
                );
            };
            (
                "Mình đề xuất điều chỉnh tồn kho thêm 1.".into(),
                json!({"product_id":item["product_id"],"delta":1,"reason":"Điều chỉnh thử từ trợ lý"}),
            )
        }
    };
    (text, vec![call(propose, 2, args)])
}
fn tool_error(data: &Value) -> Option<&str> {
    data.get("error").map(|_| {
        data["message"]
            .as_str()
            .unwrap_or("Không thể đọc dữ liệu lúc này.")
    })
}

#[async_trait]
impl ChatModel for RuleModel {
    async fn chat(
        &self,
        request: &ChatRequest,
        deltas: &tokio::sync::mpsc::UnboundedSender<String>,
    ) -> Result<ChatResponse, ModelError> {
        let (content, tool_calls) = next(request);
        if !content.is_empty() {
            let chars: Vec<char> = content.chars().collect();
            for chunk in chars.chunks(chars.len().div_ceil(3)) {
                let _ = deltas.send(chunk.iter().collect());
            }
        }
        Ok(ChatResponse {
            model: "scripted".into(),
            finish_reason: if tool_calls.is_empty() {
                "stop"
            } else {
                "tool_calls"
            }
            .into(),
            time_to_first_token: (!content.is_empty()).then_some(Duration::ZERO),
            content,
            tool_calls,
            usage: Usage {
                input_tokens: 8,
                output_tokens: 4,
                ..Usage::default()
            },
            http_status: 200,
        })
    }
}
