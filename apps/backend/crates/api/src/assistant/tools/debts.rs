//! Debt book tools (U23). Reads and reminder text only; repayments and adjustments are proposals
//! that `actions::confirm` executes through the debt ledger. Customer details reach the model as
//! tool data and the client as a card, never telemetry.
use super::{
    MAX_ROWS, Tool, ToolContext, ToolError, ToolKind, ToolOutput,
    queries::{invalid, schema, validate},
    truncate, vnd,
};
use crate::{
    analytics::ProductEvent,
    assistant::{
        actions,
        threads::{ActionRow, action_columns, action_json},
    },
    auth::{Action, data::pool},
};
use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::{Value, json};
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

#[derive(Clone, Copy)]
enum Debts {
    List,
    Reminder,
    Repayment,
    Adjustment,
}
pub fn all() -> Vec<Arc<dyn Tool>> {
    [
        Debts::List,
        Debts::Reminder,
        Debts::Repayment,
        Debts::Adjustment,
    ]
    .into_iter()
    .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
    .collect()
}

#[async_trait]
impl Tool for Debts {
    fn name(&self) -> &'static str {
        match self {
            Self::List => "get_debts",
            Self::Reminder => "draft_debt_reminder",
            Self::Repayment => "propose_repayment",
            Self::Adjustment => "propose_debt_adjustment",
        }
    }
    fn kind(&self) -> ToolKind {
        match self {
            Self::List | Self::Reminder => ToolKind::Read,
            Self::Repayment | Self::Adjustment => ToolKind::Propose,
        }
    }
    fn description_vi(&self) -> &'static str {
        match self {
            Self::List => {
                "Xem khách đang nợ: số nợ, số ngày nợ, nợ quá hạn (hơn 7 ngày) và tổng nợ."
            }
            Self::Reminder => "Soạn tin nhắn nhắc nợ cho một khách để chủ cửa hàng gửi.",
            Self::Repayment => "Đề xuất ghi khách trả nợ, chờ chủ cửa hàng xác nhận.",
            Self::Adjustment => {
                "Đề xuất điều chỉnh sổ nợ (xóa nợ, sửa sai), chờ chủ cửa hàng xác nhận."
            }
        }
    }
    fn label_vi(&self) -> &'static str {
        match self {
            Self::List => "Đang xem sổ nợ…",
            Self::Reminder => "Đang soạn tin nhắc nợ…",
            Self::Repayment | Self::Adjustment => "Đang soạn đề xuất…",
        }
    }
    fn requires(&self) -> Option<Action> {
        Some(match self {
            Self::Adjustment => Action::AdjustDebt,
            _ => Action::RecordDebt,
        })
    }
    fn parameters(&self) -> Value {
        let customer = json!({"type":"string","format":"uuid","description":"Mã khách hàng"});
        match self {
            Self::List => schema(
                json!({"customer_query":{"type":"string","minLength":1,"maxLength":80,"description":"Một phần tên hoặc số điện thoại khách"},
                    "overdue_days":{"type":"integer","minimum":0,"maximum":3650,"description":"Chỉ lấy khoản nợ có tuổi nợ từ số ngày này trở lên"}}),
                &[],
            ),
            Self::Reminder => schema(json!({"customer_id":customer}), &["customer_id"]),
            Self::Repayment => schema(
                json!({"customer_id":customer,"amount":{"type":"integer","minimum":1,"description":"Số tiền khách trả bằng đồng"},
                    "method":{"type":"string","enum":["cash","transfer"],"description":"Tiền mặt hoặc chuyển khoản"}}),
                &["customer_id", "amount", "method"],
            ),
            Self::Adjustment => schema(
                json!({"customer_id":customer,"amount":{"type":"integer","description":"Số đồng khác 0: dương tăng nợ, âm giảm nợ"},
                    "reason":{"type":"string","minLength":1,"maxLength":200,"description":"Lý do điều chỉnh"}}),
                &["customer_id", "amount", "reason"],
            ),
        }
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        if let Some(action) = self.requires() {
            ctx.actor.require(action)?;
        }
        validate(&args, &self.parameters())?;
        match self {
            Self::List => list(ctx, &args).await,
            Self::Reminder => reminder(ctx, &args).await,
            Self::Repayment | Self::Adjustment => self.propose(ctx, &args).await,
        }
    }
}

fn customer_id(args: &Value) -> Result<Uuid, ToolError> {
    args["customer_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("Mã khách hàng không hợp lệ"))
}
/// `1.234.000đ`, the app's `formatVnd`.
fn money(amount: i64) -> String {
    vnd(amount).replace(" ₫", "đ")
}
fn age(oldest: Option<NaiveDate>, today: NaiveDate) -> Option<i64> {
    oldest.map(|d| (today - d).num_days().max(0))
}

type Row = (
    Uuid,
    String,
    Option<String>,
    i64,
    Option<NaiveDate>,
    i64,
    i64,
);
async fn list(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let query = args.get("customer_query").and_then(Value::as_str);
    let min_age = args.get("overdue_days").and_then(Value::as_i64);
    let rows: Vec<Row> = sqlx::query_as("SELECT id,name,phone,balance,oldest_debt_date,(sum(balance) OVER())::bigint,(count(*) OVER())::bigint FROM customers WHERE store_id=$1 AND archived_at IS NULL AND balance>0 AND ($2::text IS NULL OR strpos(lower(name),lower($2))>0 OR strpos(lower(coalesce(phone,'')),lower($2))>0) AND ($3::int IS NULL OR coalesce(oldest_debt_date <= $4::date - $3::int,false)) ORDER BY balance DESC,id LIMIT $5")
        .bind(ctx.actor.store_id).bind(query).bind(min_age.map(|n| n as i32)).bind(ctx.today).bind(MAX_ROWS as i64 + 1)
        .fetch_all(pool(&ctx.state)?).await?;
    let (total, count) = rows.first().map_or((0, 0), |r| (r.5, r.6));
    let (rows, truncated) = truncate(rows);
    let mut overdue_count = 0;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let days = age(r.4, ctx.today);
            let overdue = days.is_some_and(|d| d > 7);
            overdue_count += i64::from(overdue);
            json!({"customer_id":r.0,"name":r.1,"phone":r.2,"balance":r.3,"debt_age_days":days,"overdue":overdue})
        })
        .collect();
    let card_items: Vec<Value> = rows
        .iter()
        .map(|r| json!({"customer_id":r.0,"name":r.1,"total":r.3,"overdue_days":age(r.4,ctx.today).unwrap_or(0)}))
        .collect();
    let summary = if count == 0 {
        "Không có khách nào đang nợ".to_owned()
    } else {
        format!("{count} khách đang nợ, tổng {}", money(total))
    };
    let mut output = ToolOutput::new(
        json!({"customers":items,"total_outstanding":total,"customer_count":count,"overdue_in_list":overdue_count,"truncated":truncated}),
        summary,
    );
    output.rows = items.len();
    output.truncated = truncated;
    if !card_items.is_empty() {
        output.card = Some(json!({"type":"debt_list","items":card_items}));
    }
    Ok(output)
}

/// The app's `transferNote`: upper case, no diacritics, at most 25 characters, trimmed.
fn transfer_note(name: &str) -> String {
    let ascii: String = format!("TRA NO {name}")
        .to_uppercase()
        .replace(['đ', 'Đ'], "D")
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect();
    ascii.chars().take(25).collect::<String>().trim().to_owned()
}
/// Mirrors `buildReminderText` in `apps/mobile/src/features/debts/reminder.ts`.
pub(crate) fn reminder_text(
    name: &str,
    balance: i64,
    store: &str,
    bank: Option<(&str, &str, &str)>,
) -> Option<String> {
    if balance <= 0 {
        return None;
    }
    let mut lines = vec![format!(
        "Chào {name}, {store} xin nhắc khoản nợ còn lại của bạn là {}.",
        money(balance)
    )];
    if let Some((bank, number, holder)) = bank {
        lines.push(format!(
            "Bạn có thể chuyển khoản: {bank} - {number} - {holder}"
        ));
        lines.push(format!("Nội dung chuyển khoản: {}", transfer_note(name)));
    }
    lines.push("Cảm ơn bạn!".into());
    Some(lines.join("\n"))
}
type ReminderRow = (
    String,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
async fn reminder(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let id = customer_id(args)?;
    let row: Option<ReminderRow> = sqlx::query_as("SELECT c.name,c.balance,s.name,s.bank_bin,s.bank_short_name,s.bank_account_number,s.bank_account_name FROM customers c JOIN stores s ON s.id=c.store_id WHERE c.store_id=$1 AND c.id=$2")
        .bind(ctx.actor.store_id).bind(id).fetch_optional(pool(&ctx.state)?).await?;
    let (name, balance, store, bin, short, number, holder) =
        row.ok_or_else(|| ToolError::NotFound("Không tìm thấy khách hàng".into()))?;
    let bank = match (&bin, &number, &holder) {
        (Some(bin), Some(number), Some(holder)) => Some((
            short.as_deref().unwrap_or(bin.as_str()),
            number.as_str(),
            holder.as_str(),
        )),
        _ => None,
    };
    let Some(text) = reminder_text(&name, balance, &store, bank) else {
        let mut output = ToolOutput::new(
            json!({"customer_id":id,"name":name,"balance":balance,"reminder_vi":null,"note":"Khách không còn nợ, không cần nhắc"}),
            format!("{name} không còn nợ"),
        );
        output.rows = 1;
        return Ok(output);
    };
    let mut output = ToolOutput::new(
        json!({"customer_id":id,"name":name,"balance":balance,"reminder_vi":text,"note":"Chủ cửa hàng tự gửi tin nhắn này; trợ lý không gửi."}),
        format!("Tin nhắc nợ cho {name}"),
    );
    output.rows = 1;
    Ok(output)
}

impl Debts {
    fn action_kind(self) -> &'static str {
        if matches!(self, Self::Repayment) {
            "repayment"
        } else {
            "debt_adjustment"
        }
    }
    async fn propose(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let id = customer_id(args)?;
        let (name, balance): (String, i64) = sqlx::query_as("SELECT name,balance FROM customers WHERE store_id=$1 AND id=$2 AND archived_at IS NULL")
            .bind(ctx.actor.store_id).bind(id).fetch_optional(pool(&ctx.state)?).await?
            .ok_or_else(|| ToolError::NotFound("Không tìm thấy khách hàng".into()))?;
        let amount = args["amount"].as_i64().unwrap_or(0);
        let (payload, summary) = if matches!(self, Self::Repayment) {
            let method = args["method"].as_str().unwrap_or_default();
            if amount < 1 || !["cash", "transfer"].contains(&method) {
                return Err(invalid("Số tiền hoặc hình thức trả không hợp lệ"));
            }
            (
                json!({"customer_id":id,"customer_name":name,"amount":amount,"method":method,"balance_before":balance}),
                format!("{name} trả nợ {}", money(amount)),
            )
        } else {
            let reason = args["reason"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_owned();
            if amount == 0
                || amount == i64::MIN
                || reason.is_empty()
                || reason.chars().count() > 200
                || balance.checked_add(amount).is_none()
            {
                return Err(invalid("Số tiền hoặc lý do điều chỉnh không hợp lệ"));
            }
            (
                json!({"customer_id":id,"customer_name":name,"amount":amount,"reason":reason,"balance_before":balance}),
                format!("Điều chỉnh nợ {name}: {}", money(amount)),
            )
        };
        // Enforce the context's ownership even when called directly, outside the loop.
        let row: ActionRow = sqlx::query_as(concat!("INSERT INTO assistant_actions(id,store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,trace_id,span_id,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '24 hours' WHERE EXISTS(SELECT 1 FROM assistant_threads t JOIN assistant_messages m ON m.thread_id=t.id AND m.store_id=t.store_id WHERE t.id=$3 AND t.store_id=$2 AND t.member_id=$8 AND m.id=$4 AND m.role='assistant') RETURNING ",action_columns!()))
            .bind(Uuid::now_v7()).bind(ctx.actor.store_id).bind(ctx.thread_id).bind(ctx.message_id)
            .bind(self.action_kind()).bind(payload).bind(&summary).bind(ctx.actor.member_id).bind(&ctx.trace_id).bind(super::super::telemetry::span_id(&tracing::Span::current()))
            .fetch_optional(pool(&ctx.state)?).await?.ok_or_else(|| ToolError::NotFound("Không tìm thấy cuộc trò chuyện".into()))?;
        if let Some(kind) = actions::analytics_kind(self.action_kind()) {
            actions::capture(
                &ctx.state,
                &ctx.actor,
                ProductEvent::AssistantActionProposed { kind },
                ctx.trace_id.as_deref(),
            );
        }
        sqlx::query("UPDATE assistant_messages SET span_id=COALESCE(span_id,$2) WHERE id=$1 AND store_id=$3")
            .bind(ctx.message_id).bind(&row.span_id).bind(ctx.actor.store_id).execute(pool(&ctx.state)?).await?;
        let mut output = ToolOutput::new(
            json!({"action_id":row.id,"status":"proposed","summary_vi":summary,"note":"Chờ chủ cửa hàng bấm Xác nhận"}),
            summary,
        );
        output.action = Some(action_json(&row));
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_matches_the_app_format() {
        assert_eq!(money(1_234_000), "1.234.000đ");
        assert_eq!(money(500), "500đ");
    }
    #[test]
    fn reminder_without_bank_has_no_transfer_lines() {
        assert_eq!(
            reminder_text("Chị Lan", 150_000, "Tạp hóa Hoa", None).unwrap(),
            "Chào Chị Lan, Tạp hóa Hoa xin nhắc khoản nợ còn lại của bạn là 150.000đ.\nCảm ơn bạn!"
        );
    }
    #[test]
    fn reminder_with_bank_adds_account_and_ascii_note() {
        let text = reminder_text(
            "Nguyễn Đức Thắng",
            2_000_000,
            "Tạp hóa Hoa",
            Some(("VCB", "0123456789", "NGUYEN VAN A")),
        )
        .unwrap();
        assert_eq!(
            text,
            "Chào Nguyễn Đức Thắng, Tạp hóa Hoa xin nhắc khoản nợ còn lại của bạn là 2.000.000đ.\nBạn có thể chuyển khoản: VCB - 0123456789 - NGUYEN VAN A\nNội dung chuyển khoản: TRA NO NGUYEN DUC THANG\nCảm ơn bạn!"
        );
    }
    #[test]
    fn transfer_note_is_clamped_and_trimmed() {
        assert_eq!(transfer_note(&"A".repeat(40)).chars().count(), 25);
        assert_eq!(transfer_note("Đỗ"), "TRA NO DO");
        // Cut at 25 characters, then trimmed: no trailing space remains.
        assert_eq!(
            transfer_note("Bình An Nhà Bên Cạnh"),
            "TRA NO BINH AN NHA BEN CA"
        );
        assert_eq!(transfer_note("Ngô Văn Ba Mươi"), "TRA NO NGO VAN BA MUOI");
        assert_eq!(
            transfer_note("Ngô Văn Hai Chín  Z"),
            "TRA NO NGO VAN HAI CHIN"
        );
    }
    #[test]
    fn nothing_to_remind_when_balance_is_not_positive() {
        assert!(reminder_text("A", 0, "S", None).is_none());
        assert!(reminder_text("A", -5, "S", None).is_none());
    }
}
