//! Draft writes for explicit confirmation. Only assistant rows change here.
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput, vnd};
use crate::{
    assistant::{
        actions,
        threads::{ActionRow, action_columns, action_json},
    },
    auth::{self, Action, data::pool},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Copy)]
enum Propose {
    Stock,
    Expense,
    Price,
    Threshold,
    Reorder,
    ReceiptLine,
    ReceiptConfirm,
    Invite,
}
pub fn all() -> Vec<Arc<dyn Tool>> {
    [
        Propose::Stock,
        Propose::Expense,
        Propose::Price,
        Propose::Threshold,
        Propose::Reorder,
        Propose::ReceiptLine,
        Propose::ReceiptConfirm,
        Propose::Invite,
    ]
    .into_iter()
    .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
    .collect()
}
impl Propose {
    fn action_kind(self) -> &'static str {
        match self {
            Self::Stock => "stock_adjustment",
            Self::Expense => "expense",
            Self::Price => "price_change",
            Self::Threshold => "threshold_update",
            Self::Reorder => "reorder_list",
            Self::ReceiptLine => "receipt_line_update",
            Self::ReceiptConfirm => "receipt_confirm",
            Self::Invite => "invite",
        }
    }
}
fn invalid(message: &str) -> ToolError {
    ToolError::InvalidArguments(message.into())
}
fn number(args: &Value, name: &str, min: i64, max: i64) -> Result<i64, ToolError> {
    args[name]
        .as_i64()
        .filter(|v| (min..=max).contains(v))
        .ok_or_else(|| invalid("Số tiền hoặc số lượng không hợp lệ"))
}
fn text(args: &Value, name: &str, max: usize) -> Result<String, ToolError> {
    args[name]
        .as_str()
        .filter(|s| s.chars().count() <= max)
        .map(str::to_owned)
        .ok_or_else(|| invalid("Nội dung bị thiếu hoặc quá dài"))
}
fn uuid(args: &Value, name: &str) -> Result<Uuid, ToolError> {
    args[name]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| invalid("Mã sản phẩm, hóa đơn hoặc dòng không hợp lệ"))
}
async fn product(ctx: &ToolContext, id: Uuid) -> Result<Value, ToolError> {
    sqlx::query_scalar("SELECT jsonb_build_object('product_id',p.id,'name',coalesce(p.name,''),'price',p.price,'stock_quantity',p.stock_quantity,'low_stock_threshold',p.low_stock_threshold,'unit_cost',coalesce((SELECT l.base_unit_cost FROM purchase_lines l JOIN expenses e ON e.id=l.expense_id AND e.store_id=l.store_id WHERE l.store_id=p.store_id AND l.product_id=p.id AND e.deleted_at IS NULL ORDER BY e.spent_at DESC,l.id DESC LIMIT 1),p.cost_price)) FROM products p WHERE p.store_id=$1 AND p.id=$2 AND NOT p.archived")
        .bind(ctx.actor.store_id).bind(id).fetch_optional(pool(&ctx.state)?).await?
        .ok_or_else(|| ToolError::NotFound("Không tìm thấy sản phẩm".into()))
}

#[async_trait]
impl Tool for Propose {
    fn name(&self) -> &'static str {
        match self {
            Self::Stock => "propose_stock_adjustment",
            Self::Expense => "propose_expense",
            Self::Price => "propose_price_change",
            Self::Threshold => "propose_threshold_update",
            Self::Reorder => "propose_reorder_list",
            Self::ReceiptLine => "propose_receipt_line_update",
            Self::ReceiptConfirm => "propose_receipt_confirm",
            Self::Invite => "propose_invite",
        }
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Propose
    }
    fn requires(&self) -> Option<Action> {
        match self {
            Self::Stock | Self::Threshold => Some(Action::AdjustStock),
            Self::Expense => Some(Action::AddExpense),
            Self::Price => Some(Action::ChangePrice),
            Self::Reorder => None,
            Self::ReceiptLine | Self::ReceiptConfirm => Some(Action::EnrollProduct),
            Self::Invite => Some(Action::ManageInvites),
        }
    }
    fn description_vi(&self) -> &'static str {
        match self {
            Self::Stock => "Đề xuất điều chỉnh tồn kho, chờ chủ cửa hàng xác nhận.",
            Self::Expense => "Đề xuất ghi chi phí điện, nước hoặc chi khác, chờ xác nhận.",
            Self::Price => "Đề xuất đổi giá bán sản phẩm, chờ xác nhận.",
            Self::Threshold => "Đề xuất đổi ngưỡng tồn kho thấp, chờ xác nhận.",
            Self::Reorder => "Soạn danh sách nhập hàng để chia sẻ, không đổi tồn kho.",
            Self::ReceiptLine => "Đề xuất sửa một dòng hóa đơn nháp, chờ xác nhận.",
            Self::ReceiptConfirm => "Đề xuất xác nhận hóa đơn nhập hàng, chờ xác nhận.",
            Self::Invite => "Đề xuất tạo lời mời thành viên, chờ xác nhận.",
        }
    }
    fn label_vi(&self) -> &'static str {
        "Đang soạn đề xuất…"
    }
    fn parameters(&self) -> Value {
        let product = json!({"type":"string","format":"uuid","description":"Mã sản phẩm"});
        let receipt = json!({"type":"string","format":"uuid","description":"Mã hóa đơn nháp"});
        let (properties, required) = match self {
            Self::Stock => (
                json!({"product_id":product,"delta":{"type":"integer","minimum":i32::MIN,"maximum":i32::MAX,"not":{"const":0},"description":"Số lượng tăng hoặc giảm, khác 0"},"reason":{"type":"string","maxLength":200,"description":"Lý do điều chỉnh"}}),
                json!(["product_id", "delta", "reason"]),
            ),
            Self::Expense => (
                json!({"amount":{"type":"integer","minimum":1,"description":"Số tiền chi bằng đồng"},"category":{"type":"string","enum":["dien","nuoc","khac"],"description":"Loại chi phí"},"note":{"type":"string","maxLength":500,"description":"Ghi chú chi phí"},"paid_with":{"type":"string","enum":["cash_box","other"],"description":"Nguồn tiền chi"}}),
                json!(["amount", "category", "note", "paid_with"]),
            ),
            Self::Price => (
                json!({"product_id":product,"new_price":{"type":"integer","minimum":1,"description":"Giá bán mới bằng đồng"}}),
                json!(["product_id", "new_price"]),
            ),
            Self::Threshold => (
                json!({"product_id":product,"threshold":{"type":"integer","minimum":0,"maximum":100000,"description":"Ngưỡng cảnh báo tồn thấp mới"}}),
                json!(["product_id", "threshold"]),
            ),
            Self::Reorder => (
                json!({"items":{"type":"array","minItems":1,"maxItems":50,"description":"Các sản phẩm cần nhập","items":{"type":"object","additionalProperties":false,"required":["product_id","quantity"],"properties":{"product_id":product,"quantity":{"type":"integer","minimum":1,"maximum":i32::MAX,"description":"Số lượng cần nhập"}}}},"supplier":{"type":"string","maxLength":200,"description":"Nhà cung cấp nếu có"}}),
                json!(["items"]),
            ),
            Self::ReceiptLine => (
                json!({"receipt_id":receipt,"line_id":{"type":"string","format":"uuid","description":"Mã dòng hóa đơn"},"product_id":product,"quantity":{"type":"integer","minimum":1,"maximum":i32::MAX,"description":"Số lượng đúng"},"cost":{"type":"integer","minimum":0,"description":"Tổng tiền của dòng bằng đồng"}}),
                json!(["receipt_id", "line_id"]),
            ),
            Self::ReceiptConfirm => (
                json!({"receipt_id":receipt,"paid_with":{"type":"string","enum":["cash_box","other"],"default":"cash_box","description":"Nguồn tiền nhập hàng"}}),
                json!(["receipt_id"]),
            ),
            Self::Invite => (
                json!({"role":{"type":"string","enum":["lead","seller"],"description":"Vai trò thành viên được mời"},"can_enroll":{"type":"boolean","description":"Cho phép thêm sản phẩm và nhập hàng"}}),
                json!(["role", "can_enroll"]),
            ),
        };
        let mut schema = json!({"type":"object","additionalProperties":false,"properties":properties,"required":required});
        if matches!(self, Self::ReceiptLine) {
            schema["anyOf"] = json!([{"required":["product_id"]},{"required":["quantity"]},{"required":["cost"]}]);
        }
        schema
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        if self.requires().is_some_and(|a| !auth::can(&ctx.actor, a)) {
            return Err(ToolError::Denied);
        }
        let schema = self.parameters();
        let object = args
            .as_object()
            .ok_or_else(|| invalid("Tham số phải là một đối tượng"))?;
        if object.keys().any(|k| schema["properties"].get(k).is_none()) {
            return Err(invalid("Tham số không được hỗ trợ"));
        }
        let mut card = None;
        let (payload, summary) = match self {
            Self::Stock | Self::Price | Self::Threshold => {
                let id = uuid(&args, "product_id")?;
                let p = product(ctx, id).await?;
                let name = p["name"].as_str().unwrap_or_default();
                match self {
                    Self::Stock => {
                        let delta =
                            number(&args, "delta", i64::from(i32::MIN), i64::from(i32::MAX))?;
                        if delta == 0 {
                            return Err(invalid("Số lượng điều chỉnh phải khác 0"));
                        }
                        let reason = text(&args, "reason", 200)?;
                        (
                            json!({"product_id":id,"product_name":name,"delta":delta,"reason":reason,"current_stock":p["stock_quantity"]}),
                            format!("Điều chỉnh tồn kho {name}: {delta:+}"),
                        )
                    }
                    Self::Price => {
                        let price = number(&args, "new_price", 1, i64::MAX)?;
                        (
                            json!({"product_id":id,"product_name":name,"old_price":p["price"],"new_price":price}),
                            format!("Đổi giá {name} thành {}", vnd(price)),
                        )
                    }
                    _ => {
                        let threshold = number(&args, "threshold", 0, 100000)?;
                        (
                            json!({"product_id":id,"product_name":name,"old_threshold":p["low_stock_threshold"],"threshold":threshold}),
                            format!("Đổi ngưỡng tồn thấp {name} thành {threshold}"),
                        )
                    }
                }
            }
            Self::Expense => {
                let amount = number(&args, "amount", 1, i64::MAX)?;
                let category = text(&args, "category", 20)?;
                if !["dien", "nuoc", "khac"].contains(&category.as_str()) {
                    return Err(invalid("Loại chi phí không hợp lệ"));
                }
                let note = text(&args, "note", 500)?;
                let paid_with = paid_with(&args, false)?;
                (
                    json!({"amount":amount,"category":category,"note":note,"paid_with":paid_with}),
                    format!("Ghi chi phí {}", vnd(amount)),
                )
            }
            Self::Reorder => {
                let items = args["items"]
                    .as_array()
                    .filter(|a| (1..=50).contains(&a.len()))
                    .ok_or_else(|| invalid("Danh sách nhập phải có từ 1 đến 50 sản phẩm"))?;
                let supplier = args
                    .get("supplier")
                    .map(|_| text(&args, "supplier", 200))
                    .transpose()?;
                let costs = auth::can(&ctx.actor, Action::ChangePrice);
                let mut rows = Vec::new();
                let mut total = Some(0i64);
                for item in items {
                    if item.as_object().is_none_or(|o| {
                        o.keys()
                            .any(|k| !["product_id", "quantity"].contains(&k.as_str()))
                    }) {
                        return Err(invalid("Dòng nhập hàng không hợp lệ"));
                    }
                    let p = product(ctx, uuid(item, "product_id")?).await?;
                    let quantity = number(item, "quantity", 1, i64::from(i32::MAX))?;
                    let cost = if costs { p["unit_cost"].as_i64() } else { None };
                    let line_total = cost
                        .map(|c| {
                            c.checked_mul(quantity)
                                .ok_or_else(|| invalid("Tổng tiền vượt giới hạn"))
                        })
                        .transpose()?;
                    total = total
                        .zip(line_total)
                        .map(|(sum, n)| {
                            sum.checked_add(n)
                                .ok_or_else(|| invalid("Tổng tiền vượt giới hạn"))
                        })
                        .transpose()?;
                    rows.push(json!({"product_id":p["product_id"],"name":p["name"],"quantity":quantity,"unit_cost":cost,"total_cost":line_total}));
                }
                card = Some(json!({"type":"restock_list","items":rows,"total_cost":total}));
                (
                    json!({"items":rows,"supplier":supplier,"total_cost":total}),
                    format!("Danh sách nhập {} sản phẩm", items.len()),
                )
            }
            Self::ReceiptLine | Self::ReceiptConfirm => {
                let id = uuid(&args, "receipt_id")?;
                let snapshot = actions::receipt_snapshot(pool(&ctx.state)?, ctx.actor.store_id, id)
                    .await?
                    .ok_or_else(|| ToolError::NotFound("Không tìm thấy hóa đơn".into()))?;
                if snapshot["status"] != "draft" {
                    return Err(invalid("Hóa đơn không còn ở trạng thái nháp"));
                }
                if matches!(self, Self::ReceiptLine) {
                    let line_id = uuid(&args, "line_id")?;
                    let old = snapshot["lines"]
                        .as_array()
                        .and_then(|lines| lines.iter().find(|l| l["line_id"] == json!(line_id)))
                        .ok_or_else(|| ToolError::NotFound("Không tìm thấy dòng hóa đơn".into()))?;
                    let mut changes = json!({});
                    if args.get("product_id").is_some() {
                        let p = uuid(&args, "product_id")?;
                        product(ctx, p).await?;
                        changes["product_id"] = json!(p);
                    }
                    if args.get("product_id").is_none() && !old["product_id"].is_null() {
                        product(ctx, uuid(old, "product_id")?).await?;
                    }
                    if args.get("quantity").is_some() {
                        changes["quantity"] =
                            json!(number(&args, "quantity", 1, i64::from(i32::MAX))?);
                    }
                    if args.get("cost").is_some() {
                        changes["cost"] = json!(number(&args, "cost", 0, i64::MAX)?);
                    }
                    if changes.as_object().is_none_or(|c| c.is_empty()) {
                        return Err(invalid("Cần thay đổi ít nhất một giá trị của dòng"));
                    }
                    (
                        json!({"receipt_id":id,"line_id":line_id,"old_line":old,"new_values":changes}),
                        "Sửa dòng hóa đơn nhập hàng".into(),
                    )
                } else {
                    for line in snapshot["lines"].as_array().into_iter().flatten() {
                        if !line["product_id"].is_null() {
                            product(ctx, uuid(line, "product_id")?).await?;
                        }
                    }
                    (
                        json!({"receipt_id":id,"lines":snapshot["lines"],"paid_with":paid_with(&args,true)?}),
                        "Xác nhận hóa đơn nhập hàng".into(),
                    )
                }
            }
            Self::Invite => {
                let role = text(&args, "role", 10)?;
                if !["lead", "seller"].contains(&role.as_str()) {
                    return Err(invalid("Vai trò không hợp lệ"));
                }
                let enroll = args["can_enroll"]
                    .as_bool()
                    .ok_or_else(|| invalid("Quyền thêm sản phẩm không hợp lệ"))?;
                (
                    json!({"role":role,"can_enroll":enroll}),
                    "Tạo lời mời thành viên cửa hàng".into(),
                )
            }
        };
        // Enforce the context's ownership even when called directly, outside the loop.
        let row: ActionRow = sqlx::query_as(concat!("INSERT INTO assistant_actions(id,store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,trace_id,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '24 hours' WHERE EXISTS(SELECT 1 FROM assistant_threads t JOIN assistant_messages m ON m.thread_id=t.id AND m.store_id=t.store_id WHERE t.id=$3 AND t.store_id=$2 AND t.member_id=$8 AND m.id=$4 AND m.role='assistant') RETURNING ",action_columns!()))
            .bind(Uuid::now_v7()).bind(ctx.actor.store_id).bind(ctx.thread_id).bind(ctx.message_id)
            .bind(self.action_kind()).bind(payload).bind(&summary).bind(ctx.actor.member_id).bind(&ctx.trace_id)
            .fetch_optional(pool(&ctx.state)?).await?.ok_or_else(||ToolError::NotFound("Không tìm thấy cuộc trò chuyện".into()))?;
        if let Some(kind) = actions::analytics_kind(self.action_kind()) {
            actions::capture(
                &ctx.state,
                &ctx.actor,
                crate::analytics::ProductEvent::AssistantActionProposed { kind },
            );
        }
        let mut output = ToolOutput::new(
            json!({"action_id":row.id,"status":"proposed","summary_vi":summary,"note":"Chờ chủ cửa hàng bấm Xác nhận"}),
            summary,
        );
        output.card = card;
        output.action = Some(action_json(&row));
        Ok(output)
    }
}
fn paid_with(args: &Value, default: bool) -> Result<&str, ToolError> {
    let value = if default && args.get("paid_with").is_none() {
        "cash_box"
    } else {
        args["paid_with"]
            .as_str()
            .ok_or_else(|| invalid("Nguồn tiền không hợp lệ"))?
    };
    if ["cash_box", "other"].contains(&value) {
        Ok(value)
    } else {
        Err(invalid("Nguồn tiền không hợp lệ"))
    }
}
