//! Shared argument and output helpers for the sales/stock read tools.
use super::{ToolContext, ToolError, ToolOutput};
use chrono::{Datelike, Duration, NaiveDate};
use serde_json::{Value, json};

pub(super) fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
pub(super) fn ranged(extra: Value) -> Value {
    let mut properties = json!({
        "from":{"type":"string","format":"date","description":"Ngày bắt đầu, gồm ngày này; mặc định hôm nay (giờ Việt Nam)."},
        "to":{"type":"string","format":"date","description":"Ngày kết thúc, gồm ngày này; mặc định hôm nay (giờ Việt Nam)."}
    });
    properties
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    schema(properties, &[])
}
pub(super) fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::InvalidArguments(message.into())
}
/// Validate the subset of JSON Schema used by this batch, also at execution time.
pub(super) fn validate(args: &Value, schema: &Value) -> Result<(), ToolError> {
    let object = args
        .as_object()
        .ok_or_else(|| invalid("Cần một đối tượng JSON"))?;
    let properties = schema["properties"].as_object().unwrap();
    for required in schema["required"].as_array().unwrap() {
        if !object.contains_key(required.as_str().unwrap()) {
            return Err(invalid(format!("Thiếu {}", required.as_str().unwrap())));
        }
    }
    for (key, value) in object {
        let property = properties
            .get(key)
            .ok_or_else(|| invalid(format!("Tham số không hợp lệ: {key}")))?;
        let valid_type = match property["type"].as_str() {
            Some("string") => value.as_str().is_some_and(|s| {
                let len = s.chars().count() as u64;
                property["minLength"]
                    .as_u64()
                    .is_none_or(|min| len >= min && !s.trim().is_empty())
                    && property["maxLength"].as_u64().is_none_or(|max| len <= max)
            }),
            Some("integer") => value.as_i64().is_some(),
            Some("number") => value.as_f64().is_some(),
            _ => false,
        };
        if !valid_type
            || property["enum"]
                .as_array()
                .is_some_and(|values| !values.contains(value))
        {
            return Err(invalid(format!("Giá trị không hợp lệ: {key}")));
        }
        if let Some(number) = value.as_f64()
            && (property["minimum"].as_f64().is_some_and(|min| number < min)
                || property["maximum"].as_f64().is_some_and(|max| number > max)
                || property["exclusiveMaximum"]
                    .as_f64()
                    .is_some_and(|max| number >= max))
        {
            return Err(invalid(format!("Giá trị ngoài giới hạn: {key}")));
        }
        if property["format"] == "date" {
            date(value.as_str().unwrap())?;
        }
    }
    Ok(())
}
fn date(text: &str) -> Result<NaiveDate, ToolError> {
    text.parse::<NaiveDate>()
        .ok()
        .filter(|d| text.len() == 10 && (1..=9999).contains(&d.year()))
        .ok_or_else(|| invalid("Ngày phải có dạng YYYY-MM-DD"))
}
pub(super) fn shift(day: NaiveDate, days: i64) -> Result<NaiveDate, ToolError> {
    day.checked_add_signed(Duration::days(days))
        .filter(|d| (1..=9999).contains(&d.year()))
        .ok_or_else(|| invalid("Khoảng ngày ngoài giới hạn"))
}
pub(super) fn range(ctx: &ToolContext, args: &Value) -> Result<(NaiveDate, NaiveDate), ToolError> {
    let from = args["from"]
        .as_str()
        .map(date)
        .transpose()?
        .unwrap_or(ctx.today);
    let to = args["to"]
        .as_str()
        .map(date)
        .transpose()?
        .unwrap_or(ctx.today);
    if from > to {
        return Err(invalid("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc"));
    }
    Ok((from, to))
}
pub(super) fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str()
}
pub(super) fn integer(args: &Value, key: &str, default: i64) -> i64 {
    args[key].as_i64().unwrap_or(default)
}
pub(super) fn capped(mut items: Vec<Value>, limit: usize) -> (Vec<Value>, bool) {
    let truncated = items.len() > limit;
    items.truncate(limit);
    (items, truncated)
}
pub(super) fn output(mut data: Value, rows: usize, truncated: bool, summary: String) -> ToolOutput {
    data["rows"] = json!(rows);
    data["truncated"] = json!(truncated);
    data["summary_vi"] = json!(summary);
    let mut out = ToolOutput::new(data, summary);
    out.rows = rows;
    out.truncated = truncated;
    out
}
pub(super) fn items_output(items: Vec<Value>, limit: usize, noun: &str) -> ToolOutput {
    let (items, truncated) = capped(items, limit);
    let rows = items.len();
    output(
        json!({"items":items}),
        rows,
        truncated,
        format!("{rows} {noun}"),
    )
}
pub(super) fn hide_profit(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("gross_profit_dong");
        object.remove("profit_unpriced_lines");
    }
}

// Every purchase (including a confirmed receipt) is represented once in purchase_lines.
// Base-unit costs match expenses::create_in_transaction; deleted/future purchases are excluded.
macro_rules! purchase_cte {
    () => {
        r#"
WITH purchases AS (
    SELECT l.product_id,l.base_unit_cost unit_cost_dong,e.business_date date,e.spent_at,l.id,
        r.supplier
    FROM purchase_lines l JOIN expenses e ON e.id=l.expense_id AND e.store_id=l.store_id
    LEFT JOIN LATERAL (
        SELECT r.supplier FROM receipts r WHERE r.store_id=e.store_id AND r.expense_id=e.id
            AND r.status='confirmed' ORDER BY r.confirmed_at DESC NULLS LAST,r.id DESC LIMIT 1
    ) r ON true
    WHERE l.store_id=$1 AND e.deleted_at IS NULL AND e.business_date <= $2
), latest AS (
    SELECT DISTINCT ON (product_id) product_id,unit_cost_dong,supplier,date
    FROM purchases ORDER BY product_id,date DESC,spent_at DESC,id DESC
)
"#
    };
}
pub(super) use purchase_cte;
