//! Numerical evidence for a reply. Keep decimal precision and signs until matching, rather
//! than rounding both claims and evidence to integers. This checks numbers, not their meaning.
use serde_json::Value;
use std::collections::BTreeMap;

const UNITS: &[&str] = &[
    "₫",
    "đ",
    "đồng",
    "vnd",
    "đơn",
    "sản phẩm",
    "món",
    "dòng",
    "người",
    "ảnh",
    "lời mời",
    "thành viên",
    "nhân viên",
    "mục",
    "bản ghi",
    "lần",
    "ngày",
    "cái",
    "chai",
    "gói",
    "lon",
    "hộp",
    "thùng",
    "vỉ",
    "viên",
    "lít",
    "bịch",
    "túi",
    "bó",
    "mặt hàng",
    "khách",
    "orders",
    "units",
    "items",
    "photos",
    "kg",
    "ml",
    "g",
    "l",
    "%",
];
const SCALES: &[(&str, f64)] = &[
    ("tỷ", 1e9),
    ("triệu", 1e6),
    ("nghìn", 1e3),
    ("ngàn", 1e3),
    ("tr", 1e6),
    ("m", 1e6),
    ("k", 1e3),
];

#[derive(Clone, Copy, Debug)]
struct Figure {
    value: f64,
    /// Resolution of the displayed number, e.g. 0.1 million or 0.01 percent.
    step: f64,
    percent: bool,
}
impl Figure {
    fn matches(self, value: f64) -> bool {
        // Half-open rounding interval: 12.5 must not validate a claim of 12.
        let delta = (value - self.value) * if self.value < 0.0 { -1.0 } else { 1.0 };
        delta >= -self.step / 2.0 - 1e-8 && delta < self.step / 2.0 - 1e-8 || delta.abs() < 1e-8
    }
}
fn boundary(rest: &str) -> bool {
    !rest.chars().next().is_some_and(char::is_alphanumeric)
}
fn prefix<'a>(rest: &'a str, word: &str) -> Option<&'a str> {
    rest.strip_prefix(word).filter(|tail| boundary(tail))
}
/// Identifiers and links are not quantities. Mask them before lexing so UUID components,
/// download parameters and rule versions do not become numerical claims or evidence.
fn prose(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .map(|token| {
            let plain = token.trim_matches(|c: char| !c.is_alphanumeric() && c != '/');
            let short_id = plain.split_once("-…").is_some_and(|(head, tail)| {
                head.len() == 8
                    && head.chars().all(|c| c.is_ascii_hexdigit())
                    && !tail.is_empty()
                    && tail.chars().all(|c| c.is_ascii_hexdigit())
            }) || token.contains('`')
                && token
                    .trim_start_matches('`')
                    .trim_end_matches(|c: char| !c.is_alphanumeric())
                    .strip_prefix("...")
                    .is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit()));
            if short_id
                || token.contains("://")
                || token.contains("/v1/")
                || uuid::Uuid::parse_str(plain).is_ok()
                || token.contains("version=")
            {
                token
                    .chars()
                    .map(|c| if c.is_whitespace() { c } else { ' ' })
                    .collect()
            } else {
                token.to_lowercase().replace(['*', '`'], "")
            }
        })
        .collect()
}
fn figures(text: &str, store_only: bool) -> Vec<Figure> {
    let text = prose(text);
    let chars: Vec<char> = text.chars().collect();
    let run = |start: usize| {
        chars[start..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let mut out = vec![];
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let before: String = chars[..i]
            .iter()
            .rev()
            .take(16)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let mut end = i + run(i);
        // Calendar ranges such as 21–27/10 are not stock quantities. Keep ordinary
        // bare counts and negative values subject to evidence matching.
        if matches!(chars.get(end), Some('-' | '–' | '—'))
            && chars.get(end + 1).is_some_and(char::is_ascii_digit)
        {
            let day_end = end + 1 + run(end + 1);
            let first: u32 = chars[i..end]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            let last: u32 = chars[end + 1..day_end]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            if chars.get(day_end) == Some(&'/')
                && chars.get(day_end + 1).is_some_and(char::is_ascii_digit)
                && (1..=31).contains(&first)
                && (1..=31).contains(&last)
            {
                let month_end = day_end + 1 + run(day_end + 1);
                let month: u32 = chars[day_end + 1..month_end]
                    .iter()
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
                if (1..=12).contains(&month) {
                    i = if chars.get(month_end) == Some(&'/') {
                        month_end + 1 + run(month_end + 1)
                    } else {
                        month_end
                    };
                    continue;
                }
            }
        }
        // ISO dates, full Vietnamese dates and short day/month dates. A bare year following
        // "năm" is also a date, not a store total. Dates are validated by the tools separately.
        if matches!(chars.get(end), Some('/' | '-'))
            && chars.get(end + 1).is_some_and(char::is_ascii_digit)
        {
            let sep = chars[end];
            let second_end = end + 1 + run(end + 1);
            let first: u32 = chars[i..end]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            let second: u32 = chars[end + 1..second_end]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            if chars.get(second_end) == Some(&sep)
                && chars.get(second_end + 1).is_some_and(char::is_ascii_digit)
            {
                i = second_end + 1 + run(second_end + 1);
                continue;
            }
            let month_context = before.ends_with("tháng ") || before.ends_with("month ");
            if (sep == '/'
                && ((1..=31).contains(&first) && (1..=12).contains(&second)
                    || (1..=12).contains(&first) && (2000..=2100).contains(&second)))
                || sep == '-'
                    && month_context
                    && (1..=12).contains(&first)
                    && (1..=12).contains(&second)
            {
                i = second_end;
                continue;
            }
        }
        if chars.get(end) == Some(&':') && chars.get(end + 1).is_some_and(char::is_ascii_digit) {
            let time_end = end + 1 + run(end + 1);
            let hour: u32 = chars[i..end]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(99);
            let minute: u32 = chars[end + 1..time_end]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(99);
            if hour < 24 && minute < 60 && time_end - end == 3 {
                i = time_end;
                continue;
            }
        }
        if end - i == 4 && (before.ends_with("năm ") || before.ends_with("year ")) {
            i = end;
            continue;
        }
        let label = before.trim_end_matches([' ', ':']);
        if ["phiên bản", "quy tắc", "quy tắc thuế", "version"]
            .iter()
            .any(|word| label.ends_with(word))
        {
            // A rule version is an identifier, not a monetary/quantity claim.
            let mut version_end = end;
            while chars
                .get(version_end)
                .is_some_and(|c| c.is_ascii_digit() || *c == '.')
            {
                version_end += 1;
            }
            i = version_end;
            continue;
        }
        // A list index is formatting, even when it reaches 10 or more.
        let line: String = chars[..i]
            .iter()
            .rev()
            .take_while(|c| **c != '\n')
            .collect();
        if store_only
            && line.trim().is_empty()
            && matches!(chars.get(end), Some('.' | ')'))
            && chars.get(end + 1).is_some_and(|c| c.is_whitespace())
        {
            i = end + 1;
            continue;
        }
        let mut groups = vec![chars[i..end].iter().collect::<String>()];
        while matches!(
            chars.get(end),
            Some('.' | ',' | '\u{00a0}' | '\u{202f}' | ' ')
        ) && chars.get(end + 1).is_some_and(char::is_ascii_digit)
        {
            let n = run(end + 1);
            // Spaces group thousands only; don't join two independent counts.
            if chars[end].is_whitespace() && n != 3 {
                break;
            }
            groups.push(chars[end + 1..end + 1 + n].iter().collect());
            end += 1 + n;
        }
        let mut after = end;
        while chars.get(after).is_some_and(|c| c.is_whitespace()) {
            after += 1;
        }
        let rest: String = chars[after..].iter().take(24).collect();
        let scale = SCALES
            .iter()
            .find(|(word, _)| prefix(&rest, word).is_some());
        let factor = scale.map_or(1.0, |(_, factor)| *factor);
        let unit_rest = scale
            .and_then(|(word, _)| rest.strip_prefix(word))
            .unwrap_or(&rest)
            .trim_start();
        let percent = unit_rest.starts_with('%')
            || unit_rest.starts_with("phần trăm")
            || unit_rest.starts_with("percent");
        let unit = percent || UNITS.iter().any(|u| prefix(unit_rest, u).is_some());
        // With a multiplier, a single dot/comma is a decimal mark (1.200tr = 1.2m).
        let grouping = groups.len() > 1
            && scale.is_none()
            && groups[0].len() <= 3
            && groups[1..].iter().all(|g| g.len() == 3);
        let decimals = if groups.len() == 1 || grouping {
            0
        } else {
            groups.last().unwrap().len()
        };
        let normalized = if decimals == 0 {
            groups.concat()
        } else {
            format!(
                "{}.{}",
                groups[..groups.len() - 1].concat(),
                groups.last().unwrap()
            )
        };
        if let Ok(mut value) = normalized.parse::<f64>() {
            value *= factor;
            let sign_context = before.trim_end();
            let sign_context = ["khoảng", "xấp xỉ", "gần", "hơn", "tới"]
                .iter()
                .find_map(|word| sign_context.strip_suffix(word))
                .unwrap_or(sign_context)
                .trim_end();
            let signed = before.ends_with('-')
                || before.ends_with('−')
                || before.ends_with('‑')
                || before.ends_with("âm ")
                || before.ends_with("thiếu ")
                || before.ends_with("hụt ")
                || before.ends_with("giảm ")
                || ["âm", "thiếu", "hụt", "giảm", "lỗ"]
                    .iter()
                    .any(|word| sign_context.ends_with(word));
            if signed {
                value = -value;
            }
            if value.is_finite() && (!store_only || value.abs() >= 10.0 || scale.is_some() || unit)
            {
                out.push(Figure {
                    value,
                    step: factor / 10_f64.powi(decimals as i32),
                    percent,
                });
            }
        }
        i = end.max(i + 1);
    }
    out
}

#[derive(Default)]
struct Evidence {
    numbers: Vec<f64>,
    percents: Vec<f64>,
}
fn numeric(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
}
fn opaque(key: &str) -> bool {
    key == "id"
        || key.ends_with("_id")
        || key.ends_with("_at")
        || matches!(
            key,
            "path" | "url" | "ocr_text" | "raw_text" | "note" | "version" | "rule_version"
        )
}
impl Evidence {
    fn text(&mut self, text: &str) {
        for f in figures(text, false) {
            if f.percent {
                self.percents.push(f.value);
            } else {
                self.numbers.push(f.value);
            }
        }
    }
    fn collect(&mut self, value: &Value, key: &str) {
        if opaque(key) {
            return;
        }
        if let Some(n) = numeric(value).filter(|n| n.is_finite()) {
            if key.ends_with("basis_points") {
                self.percents.push(n / 100.0);
            } else if key.contains("pct") || key.contains("percent") {
                self.percents.push(n);
            } else if key.ends_with("rate") || matches!(key, "confidence" | "probability") {
                self.percents.push(n * 100.0);
                self.numbers.push(n);
            } else {
                self.numbers.push(n);
                // These cash-equation operands are subtracted when displayed as a ledger.
                if matches!(key, "cash_refunds_dong" | "cash_expenses_dong") {
                    self.numbers.push(-n);
                }
            }
            return;
        }
        match value {
            Value::String(s) => self.text(s),
            Value::Object(map) => {
                for (k, v) in map {
                    self.collect(
                        v,
                        if key.contains("pct") || key.contains("percent") {
                            "value_pct"
                        } else {
                            k
                        },
                    );
                }
                if let (Some(current), Some(previous)) = (
                    map.get("totals").and_then(Value::as_object),
                    map.get("previous")
                        .and_then(|p| p.get("totals"))
                        .and_then(Value::as_object),
                ) {
                    for (field, value) in current {
                        if (field.ends_with("_dong")
                            || matches!(field.as_str(), "sale_count" | "void_count"))
                            && let (Some(a), Some(b)) =
                                (numeric(value), previous.get(field).and_then(numeric))
                        {
                            self.numbers.push(a - b);
                        }
                    }
                }
                // The displayed manual-line frequency is a ratio of counts on the same
                // member row, never counts drawn from different members or periods.
                if let (Some(lines), Some(sales)) = (
                    map.get("manual_lines").and_then(numeric),
                    map.get("sale_count").and_then(numeric),
                ) && sales > 0.0
                {
                    self.percents.push(lines * 100.0 / sales);
                }
                // Known pairs with the same unit; no arbitrary arithmetic closure across fields.
                for (a, b) in [
                    ("expected_cash_dong", "counted_cash_dong"),
                    ("new_price_dong", "old_price_dong"),
                ] {
                    if let (Some(a), Some(b)) =
                        (map.get(a).and_then(numeric), map.get(b).and_then(numeric))
                    {
                        self.numbers.extend([a - b, b - a]);
                    }
                }
            }
            Value::Array(items) => {
                self.numbers.push(items.len() as f64);
                let mut columns: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
                let mut kinds = BTreeMap::<&str, usize>::new();
                let mut issues = BTreeMap::<&str, usize>::new();
                let mut few_with_photos = 0;
                for item in items {
                    if let Some(kind) = item["kind"].as_str() {
                        *kinds.entry(kind).or_default() += 1;
                    }
                    for issue in item["issues"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        *issues.entry(issue).or_default() += 1;
                        if issue == "few_references"
                            && item["reference_count"].as_u64().is_some_and(|n| n > 0)
                        {
                            few_with_photos += 1;
                        }
                    }
                }
                self.numbers
                    .extend(kinds.values().chain(issues.values()).map(|n| *n as f64));
                if !kinds.is_empty() {
                    self.numbers.push(kinds.len() as f64);
                }
                if !issues.is_empty() {
                    self.numbers.push(few_with_photos as f64);
                }
                for item in items {
                    self.collect(item, key);
                    if let Some(map) = item.as_object() {
                        for (k, v) in map {
                            // Only additive measures may be summed or averaged. IDs, dates,
                            // percentages and arbitrary numeric metadata are never operands.
                            if (k.ends_with("_dong")
                                || matches!(
                                    k.as_str(),
                                    "quantity"
                                        | "units"
                                        | "sale_count"
                                        | "voids"
                                        | "missed"
                                        | "corrected"
                                ))
                                && let Some(n) = numeric(v)
                            {
                                columns.entry(k).or_default().push(n);
                            }
                        }
                    }
                }
                for values in columns
                    .values()
                    .filter(|v| v.len() == items.len() && v.len() > 1)
                {
                    let sum: f64 = values.iter().sum();
                    self.numbers.extend([sum, sum / values.len() as f64]);
                    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
                    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    self.numbers.push(max - min);
                }
            }
            _ => {}
        }
    }
}

/// Tool arguments chosen by the model are not evidence. Only user-supplied figures and
/// successful current-turn tool data can back a claim. Do not reuse previous-turn values.
pub(super) fn unmatched_numbers<'a>(
    input: &str,
    tools: impl Iterator<Item = &'a str>,
    answer: &str,
) -> Vec<f64> {
    let mut evidence = Evidence::default();
    evidence.text(input);
    for raw in tools {
        if let Ok(value) = serde_json::from_str::<Value>(raw)
            && value.get("error").is_none()
            && value.get("from_previous_turn").is_none()
        {
            evidence.collect(&value, "");
        }
    }
    figures(answer, true)
        .into_iter()
        .filter(|claim| {
            let values = if claim.percent {
                &evidence.percents
            } else {
                &evidence.numbers
            };
            !values.iter().any(|n| claim.matches(*n))
        })
        .map(|claim| claim.value)
        .collect()
}

#[cfg(test)]
pub(super) fn has_ungrounded_number<'a>(
    input: &str,
    tools: impl Iterator<Item = &'a str>,
    answer: &str,
) -> bool {
    !unmatched_numbers(input, tools, answer).is_empty()
}

#[cfg(test)]
pub(super) fn numbers(text: &str, store_only: bool) -> Vec<i64> {
    figures(text, store_only)
        .iter()
        .map(|f| f.value.round() as i64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn blocked(data: Value, answer: &str) -> bool {
        let raw = data.to_string();
        has_ungrounded_number("", std::iter::once(raw.as_str()), answer)
    }
    #[test]
    fn cash_equation_deductions_allow_negative_operands_only() {
        let data =
            json!({"cash_refunds_dong":60000,"cash_expenses_dong":80000,"cash_sales_dong":1409000});
        assert!(!blocked(
            data.clone(),
            "Hoàn tiền −60.000 ₫, chi từ két −80.000 ₫."
        ));
        assert!(blocked(data.clone(), "Bán tiền mặt −1.409.000 ₫."));
        assert!(blocked(data, "Hoàn tiền −90.000 ₫."));
    }
    #[test]
    fn loss_word_preserves_the_negative_percentage() {
        assert!(!blocked(json!({"margin_pct":-3.13}), "Lỗ 3,1%."));
        assert!(blocked(json!({"margin_pct":-3.13}), "Lãi 3,1%."));
    }
    #[test]
    fn manual_line_ratio_uses_only_its_own_sales_count() {
        let data = json!({"items":[{"manual_lines":20,"sale_count":841}]});
        assert!(!blocked(data.clone(), "20 dòng trên 841 đơn, khoảng 2,4%."));
        assert!(blocked(data, "20 dòng trên 841 đơn, khoảng 3%."));
        assert!(blocked(json!({"manual_lines":20,"sale_count":0}), "20%."));
    }
    #[test]
    fn matcher_probabilities_are_percentages() {
        let data = json!({"candidates":[{"probability":0.38}]});
        assert!(!blocked(data.clone(), "Độ khớp 38%."));
        assert!(blocked(data, "Độ khớp 39%."));
    }
    #[test]
    fn calendar_ranges_are_not_stock_claims() {
        for range in ["21–27/10", "21-27/10", "21—27/10/2026"] {
            assert!(!blocked(
                json!({"expected_units":20}),
                &format!("Dự báo {range}: 20 quả.")
            ));
        }
        assert!(blocked(json!({"expected_units":20}), "21 quả."));
        assert!(!blocked(
            json!({"total_dong":90000}),
            "Tiền nước (9/2026): 90.000 ₫."
        ));
        assert!(blocked(
            json!({"total_dong":90000}),
            "Tiền nước (9/2026): 91.000 ₫."
        ));
    }
    #[test]
    fn live_draft_replay() {
        let cases: Value =
            serde_json::from_str(include_str!("fixtures/main-smoke-live-drafts.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let tools: Vec<_> = case["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t.as_str().unwrap())
                .collect();
            let unmatched = unmatched_numbers(
                case["input"].as_str().unwrap(),
                tools.into_iter(),
                case["draft"].as_str().unwrap(),
            );
            let expected: Vec<f64> =
                serde_json::from_value(case["unmatched_after"].clone()).unwrap();
            assert_eq!(
                unmatched, expected,
                "{} draft {}",
                case["case"], case["draft_index"]
            );
            let invented = format!(
                "{}\nDoanh thu 9.876.543.210 ₫.",
                case["draft"].as_str().unwrap()
            );
            assert!(has_ungrounded_number(
                case["input"].as_str().unwrap(),
                case["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t.as_str().unwrap()),
                &invented
            ));
        }
    }
    #[tokio::test]
    #[ignore = "requires DATABASE_URL; seeds the deterministic eval store"]
    async fn seeded_eval_tool_outputs_back_representative_golden_replies() {
        use crate::{
            AppState,
            assistant::{
                Language,
                tools::{Registry, ToolContext},
            },
            auth::{Actor, Role},
            seed::eval,
        };
        use uuid::Uuid;
        let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
            .await
            .unwrap();
        crate::MIGRATOR.run(&db).await.unwrap();
        let seeded = eval::run(&db, eval::EvalOptions::default()).await.unwrap();
        let member = seeded.members.iter().find(|m| m.role == "lead").unwrap();
        let ctx = ToolContext {
            state: AppState {
                postgres: Some(db.clone()),
                ..AppState::default()
            },
            actor: Actor {
                store_id: seeded.store_id,
                member_id: member.member_id,
                clerk_user_id: "eval".into(),
                clerk_session_id: "eval".into(),
                role: Role::Lead,
                can_enroll: true,
            },
            today: seeded.business_date,
            language: Language::Vi,
            thread_id: Uuid::new_v4(),
            message_id: Uuid::new_v4(),
            trace_id: None,
        };
        let receipt: Uuid =
            sqlx::query_scalar("SELECT id FROM receipts WHERE store_id=$1 AND status='draft'")
                .bind(ctx.actor.store_id)
                .fetch_one(&db)
                .await
                .unwrap();
        let cases = [
            (
                "U5-01",
                "explain_day_close",
                json!({"business_date":"2026-10-14"}),
                "Ngày 14/10: dự kiến 1.769.000 ₫, đếm 1.649.000 ₫, hoàn 60k, thiếu 120k.",
            ),
            (
                "U6-01",
                "list_review_queue",
                json!({}),
                "9 dòng gõ tay chờ duyệt, có coca lon.",
            ),
            (
                "U7-01",
                "get_recognition_health",
                json!({"from":"2026-08-22","to":"2026-10-20"}),
                "Bỏ sót Sữa chua Vinamilk có đường hộp 100g, nhận nhầm Pepsi lon 320ml. Cần ít nhất 3 ảnh mẫu.",
            ),
            (
                "U8-01",
                "get_member_activity",
                json!({"from":"2026-08-20","to":"2026-10-20"}),
                "Anh Tư hủy 16 đơn.",
            ),
            (
                "U9-01",
                "detect_anomalies",
                json!({"from":"2026-08-22","to":"2026-10-20"}),
                "Mì Kokomi đại 90g và Cà phê sữa Birdy lon 170ml tồn âm. Giá Đường cát trắng Biên Hòa 1kg tăng 40,9%.",
            ),
            (
                "U10-01",
                "get_tax_overview",
                json!({"year":2026,"period":"quarter"}),
                "Doanh thu quý này 39.011.500 ₫. Phiên bản 2026.1. Xác nhận với cơ quan thuế.",
            ),
            (
                "U14-04",
                "get_receipt",
                json!({"receipt_id":receipt}),
                "Dầu ăn Neptune 1L chưa chắc chắn; có 1 dòng chưa khớp.",
            ),
            (
                "U13-05/U15-01",
                "get_sales_summary",
                json!({"from":"2026-10-19","to":"2026-10-19"}),
                "Hôm qua 19/10 doanh thu 1,793 triệu đồng.",
            ),
            (
                "U16-02",
                "search_sales",
                json!({"from":"2026-10-19","to":"2026-10-19","product_query":"Pepsi"}),
                "Hôm qua bán 3 lon Pepsi 320ml.",
            ),
            (
                "U17-01",
                "get_supplier_prices",
                json!({"product_query":"Pepsi"}),
                "Sỉ Bà Sáu chợ Bình Tây rẻ nhất: 8.050 ₫ một lon, chênh 150 ₫.",
            ),
            (
                "U18-01",
                "forecast_demand",
                json!({"days":7}),
                "Dự báo 7 ngày theo 8 tuần lịch sử, xu hướng 14 ngày, có Bia 333 lon 330ml.",
            ),
            (
                "U19-01",
                "get_catalog_issues",
                json!({}),
                "Sữa đặc Ông Thọ 380g và Sữa đặc Ông Thọ đỏ 380g có thể trùng. Bật lửa Tianzi thiếu danh mục. Cần ít nhất 3 ảnh mẫu.",
            ),
            (
                "U20-01",
                "suggest_low_stock_thresholds",
                json!({}),
                "8 món chưa đặt ngưỡng riêng, có Sữa đặc Ông Thọ đỏ 380g.",
            ),
            (
                "U21-01",
                "get_setup_checklist",
                json!({}),
                "Có 3 người, 1 lời mời, 8 món thiếu ngưỡng riêng.",
            ),
            (
                "U22-01",
                "start_export",
                json!({"kind":"transactions","from":"2026-09-01","to":"2026-09-30"}),
                "Doanh thu tháng 9: 62.489.000 ₫. /v1/exports/transactions?from=2026-09-01&to=2026-09-30",
            ),
        ];
        for (id, tool, args, answer) in cases {
            let output = Registry::standard().run(&ctx, tool, args).await.unwrap();
            if id == "U14-04" {
                assert!(!output.data.to_string().contains("CANARY"));
                assert!(output.data.get("ocr_text").is_none());
            }
            assert!(
                !blocked(output.data.clone(), answer),
                "{id}: {answer}; data={}",
                output.data
            );
        }
    }
    #[test]
    fn vietnamese_and_english_money_formats() {
        for (text, value) in [
            ("1.234.000 ₫", 1_234_000),
            ("1,234,000 VND", 1_234_000),
            ("1 234 000 đ", 1_234_000),
            ("1\u{202f}234\u{202f}000 đồng", 1_234_000),
            ("1,2 triệu", 1_200_000),
            ("120k", 120_000),
            ("1.2tr", 1_200_000),
            ("1.200tr", 1_200_000),
            ("1,25 tỷ", 1_250_000_000),
        ] {
            assert_eq!(numbers(text, true), [value], "{text}");
            assert!(!blocked(json!({"revenue_dong": value}), text), "{text}");
        }
    }
    #[test]
    fn decimal_percentages_and_rates_keep_precision() {
        for text in ["12,5%", "12.50 %", "12,5 phần trăm"] {
            assert!(!blocked(json!({"rate":0.125}), text), "{text}");
            assert!(!blocked(json!({"change_pct":12.5}), text), "{text}");
        }
        assert!(blocked(json!({"change_pct":12.1}), "12,4%"));
        assert!(!blocked(json!({"change_pct":{"revenue":12.5}}), "12,5%"));
        assert!(!blocked(json!({"vat_basis_points":100}), "1%"));
        assert!(blocked(json!({"vat_basis_points":100}), "100%"));
        assert!(blocked(json!({"quantity":12.5}), "12,5%"));
        assert!(blocked(json!({"rate":0.125}), "25%"));
    }
    #[test]
    fn rounded_decreases_with_qualifiers_preserve_the_negative_sign() {
        let data = json!({"change_pct":{"revenue":-16.41025641025641}});
        for text in ["Giảm khoảng **16,4%**", "giảm xấp xỉ 16,41%"] {
            assert!(!blocked(data.clone(), text), "{text}");
        }
        assert!(blocked(data.clone(), "Tăng khoảng 16,4%"));
        assert!(blocked(data.clone(), "Giảm khoảng 16,5%"));
        assert!(blocked(
            json!({"change_pct":16.41025641025641}),
            "Giảm khoảng 16,4%"
        ));
    }

    #[test]
    fn rounding_is_limited_to_displayed_precision() {
        assert!(!blocked(
            json!({"revenue_dong":1_234_000}),
            "Khoảng 1,23 triệu đồng"
        ));
        assert!(blocked(
            json!({"revenue_dong":1_234_000}),
            "1,25 triệu đồng"
        ));
        assert!(blocked(json!({"revenue_dong":120_000}), "120.001 ₫"));
        assert!(blocked(json!({"quantity":12.5}), "12 chai"));
        assert!(!blocked(json!({"quantity":12.5}), "13 chai"));
        assert!(!blocked(json!({"quantity":-12.5}), "-13 chai"));
        assert!(blocked(json!({"quantity":-12.5}), "-12 chai"));
    }
    #[test]
    fn signed_quantities_and_small_counts() {
        for text in ["-3 chai", "−3 chai", "âm 3 chai"] {
            assert!(!blocked(json!({"quantity":-3}), text), "{text}");
        }
        assert!(blocked(json!({"quantity":-3}), "3 chai"));
        assert!(blocked(json!({"quantity":3}), "4 ảnh"));
        assert!(blocked(json!({"quantity":3}), "2 món"));
        assert!(blocked(json!({"member_count":3}), "4 thành viên"));
        assert!(blocked(json!({"pending_invite_count":1}), "5 lời mời"));
        assert!(!blocked(json!({"quantity":1.25}), "1,25 kg"));
    }
    #[test]
    fn live_format_fixes_do_not_hide_new_claims() {
        assert!(!blocked(json!({"cash_dong":1649000}), "1,649 M đồng"));
        assert!(blocked(json!({"cash_dong":1649000}), "1,650 M đồng"));
        assert!(!blocked(json!({"quantity":-120000}), "‑120 000 ₫"));
        assert!(!blocked(
            json!({}),
            "tháng 9/2026, tháng 10-12, mã `...658`, e7a10e7a-…e900"
        ));
        assert!(blocked(json!({}), "tháng 9/2026: doanh thu 99999 ₫"));
        assert!(blocked(json!({}), "mã `...658`, doanh thu 658 ₫"));
        let kinds = json!({"items":[{"kind":"negative_stock","quantity":-3},{"kind":"negative_stock","quantity":-2},{"kind":"price_change"}]});
        assert!(!blocked(kinds.clone(), "2 mặt hàng tồn âm"));
        assert!(blocked(kinds, "4 mặt hàng tồn âm"));
    }
    #[test]
    fn dates_links_ids_and_list_indices_are_not_store_figures() {
        let text = "Ngày 14/10, 2026-10-14, 14/10/2026, năm 2026, 23:41, phiên bản 2026.1\n10. Hướng dẫn\n/v1/exports/transactions?from=2026-09-01&to=2026-09-30\nhttps://example.com/4482\ne7a10e7a-0000-4000-8000-000000000000";
        assert!(!blocked(json!({}), text));
        assert!(blocked(
            json!({"product_id":"e7a10e7a-0000-4000-8000-000000000000"}),
            "8000 ₫"
        ));
        assert!(blocked(json!({}), "Phiên bản 2026.1 doanh thu 99999 ₫"));
    }
    #[test]
    fn constrained_sums_differences_averages_and_counts() {
        let data =
            json!({"items":[{"cost_dong":10000,"quantity":2},{"cost_dong":20000,"quantity":4}]});
        for text in ["Tổng 30.000 ₫", "Trung bình 15.000 ₫", "6 chai", "2 dòng"] {
            assert!(!blocked(data.clone(), text), "{text}");
        }
        assert!(!blocked(
            json!({"expected_cash_dong":1769000,"counted_cash_dong":1649000}),
            "Thiếu 120k"
        ));
        assert!(blocked(
            json!({"cost_dong":10000,"sale_count":2}),
            "10.002 ₫"
        ));
        assert!(blocked(data, "Tổng 40.000 ₫"));
        let periods =
            json!({"totals":{"revenue_dong":100000},"previous":{"totals":{"revenue_dong":80000}}});
        assert!(!blocked(periods.clone(), "Tăng 20k"));
        assert!(blocked(periods, "Tăng 15k"));
        assert!(!blocked(
            json!({"items":[{"cost_dong":8200},{"cost_dong":8050}]}),
            "Chênh lệch 150 ₫"
        ));
    }
    #[test]
    fn errors_previous_turns_and_invented_arguments_are_not_evidence() {
        for data in [
            json!({"from_previous_turn":true,"data":{"total":99999}}),
            json!({"error":"failed","total":99999}),
        ] {
            assert!(blocked(data, "99.999 ₫"));
        }
        assert!(has_ungrounded_number("", std::iter::empty(), "0 ₫ (0 đơn)"));
        assert!(!has_ungrounded_number(
            "Tôi có 42 chai",
            std::iter::empty(),
            "Bạn có 42 chai"
        ));
    }
}
