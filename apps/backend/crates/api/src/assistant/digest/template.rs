//! Deterministic wording shared by every role: never render profit or costs.
use serde_json::Value;

/// Money the way the app writes it everywhere else: `20.000đ`, never `20.000 ₫`.
fn vnd(amount: i64) -> String {
    super::super::tools::vnd(amount).replace(" ₫", "đ")
}

pub fn render(data: &Value) -> String {
    let sales = &data["sales"];
    let mut sentences = Vec::new();
    if sales["sale_count"].as_i64().unwrap_or(0) == 0 {
        sentences.push("Hôm qua chưa có đơn nào.".to_owned());
    } else {
        let mut text = format!(
            "Hôm qua cửa hàng bán {} đơn, doanh thu {}",
            sales["sale_count"],
            vnd(sales["revenue"].as_i64().unwrap_or(0))
        );
        if let Some(change) = sales["change_pct"].as_f64() {
            let rounded = (change * 10.0).round() / 10.0;
            if rounded == 0.0 {
                text.push_str(", không đổi so với hôm kia");
            } else {
                let number = format!("{:.1}", rounded.abs());
                let number = number
                    .trim_end_matches('0')
                    .trim_end_matches('.')
                    .replace('.', ",");
                text.push_str(&format!(
                    ", {} {number}% so với hôm kia",
                    if rounded > 0.0 { "tăng" } else { "giảm" }
                ));
            }
        }
        text.push('.');
        sentences.push(text);
    }
    let items = data["restock"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if items.is_empty() {
        sentences.push("Không có sản phẩm cần nhập.".into());
    } else {
        let names = items
            .iter()
            .take(3)
            .filter_map(|i| i["name"].as_str())
            .collect::<Vec<_>>()
            .join(", ");
        sentences.push(format!("Cần nhập {} sản phẩm: {names}.", items.len()));
    }
    let debts = &data["overdue_debts"];
    if debts["count"].as_i64().unwrap_or(0) == 0 {
        sentences.push("Không có nợ quá hạn.".into());
    } else {
        sentences.push(format!(
            "{} khách nợ quá hạn, tổng {}.",
            debts["count"],
            vnd(debts["total"].as_i64().unwrap_or(0))
        ));
    }
    let drafts = data["open_drafts"]["count"].as_i64().unwrap_or(0);
    if drafts > 0 {
        sentences.push(format!("{drafts} việc đang chờ xử lý."));
    }
    sentences.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data() -> Value {
        json!({"sales":{"revenue":1250000,"sale_count":12,"gross_profit":555123,"change_pct":8.0},
            "restock":[{"name":"Coca"},{"name":"Bia"},{"name":"Mì"}],
            "overdue_debts":{"count":2,"total":450000},"open_drafts":{"count":1}})
    }
    #[test]
    fn owner_summary_mentions_sales_restock_debts_and_drafts_without_profit() {
        assert_eq!(
            render(&data()),
            "Hôm qua cửa hàng bán 12 đơn, doanh thu 1.250.000đ, tăng 8% so với hôm kia. Cần nhập 3 sản phẩm: Coca, Bia, Mì. 2 khách nợ quá hạn, tổng 450.000đ. 1 việc đang chờ xử lý."
        );
    }
    #[test]
    fn money_uses_the_app_format_without_space_or_dong_sign() {
        let mut d = data();
        d["sales"]["revenue"] = json!(20000);
        let text = render(&d);
        assert!(text.contains("doanh thu 20.000đ,"), "{text}");
        assert!(!text.contains('₫'), "{text}");
    }
    #[test]
    fn zero_sales_restock_debts_and_drafts_have_sensible_wording() {
        let d = json!({"sales":{"revenue":0,"sale_count":0,"gross_profit":0,"change_pct":null},"restock":[],"overdue_debts":{"count":0,"total":0},"open_drafts":{"count":0}});
        assert_eq!(
            render(&d),
            "Hôm qua chưa có đơn nào. Không có sản phẩm cần nhập. Không có nợ quá hạn."
        );
    }
    #[test]
    fn change_is_rounded_to_one_decimal_and_null_is_omitted() {
        let mut d = data();
        for (change, text) in [
            (8.26, "tăng 8,3%"),
            (-8.24, "giảm 8,2%"),
            (0.0, "không đổi"),
        ] {
            d["sales"]["change_pct"] = json!(change);
            assert!(render(&d).contains(text), "{}", render(&d));
        }
        d["sales"]["change_pct"] = Value::Null;
        assert!(!render(&d).contains("hôm kia"));
    }
    #[test]
    fn names_are_limited_to_three() {
        let mut d = data();
        d["restock"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"Bánh"}));
        assert!(render(&d).contains("Cần nhập 4 sản phẩm: Coca, Bia, Mì."));
        assert!(!render(&d).contains("Bánh"));
    }
}
