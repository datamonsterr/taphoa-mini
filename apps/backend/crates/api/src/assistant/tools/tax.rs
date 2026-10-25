//! Versioned retail tax guidance. Revenue follows reports; taxable income is not inferred.
use super::ops::{date, invalid, parse, schema};
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput};
use crate::auth::{Action, data::pool};
use async_trait::async_trait;
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};

pub fn all() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(TaxOverview)]
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Rules {
    version: String,
    effective_from: String,
    checked_on: String,
    activity: String,
    annual_threshold_dong: i64,
    presumptive_tax_ended_on: String,
    regulation_note_vi: String,
    vat_base_note_vi: String,
    exempt_declaration_vi: String,
    quarterly_declaration_vi: String,
    monthly_declaration_vi: String,
    einvoice_vi: String,
    income_method_note_vi: String,
    disclaimer_vi: String,
    bands: Vec<Band>,
    sources: Vec<Source>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Band {
    key: String,
    min_revenue_dong: i64,
    max_revenue_dong: Option<i64>,
    vat_basis_points: i64,
    pit_basis_points: i64,
    pit_method: String,
    pit_allowance_dong: i64,
    alternative_income_basis_points: Option<i64>,
    filing: String,
    confidence: String,
    note_vi: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Source {
    url: String,
    title: String,
}
static RULES: LazyLock<Rules> = LazyLock::new(|| {
    toml::from_str(include_str!("../rules/tax_vn.toml")).expect("valid embedded tax rules")
});
fn band(revenue: i64) -> &'static Band {
    RULES
        .bands
        .iter()
        .find(|b| {
            revenue >= b.min_revenue_dong && b.max_revenue_dong.is_none_or(|max| revenue <= max)
        })
        .expect("contiguous tax bands")
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Period {
    Month,
    Quarter,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    year: i32,
    period: Period,
}
fn amount(base: i64, basis_points: i64) -> i64 {
    ((i128::from(base) * i128::from(basis_points)) / 10000) as i64
}
struct TaxOverview;
#[async_trait]
impl Tool for TaxOverview {
    fn name(&self) -> &'static str {
        "get_tax_overview"
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        "Dùng khi chủ cửa hàng cần doanh thu năm theo tháng hoặc quý, dải thuế bán lẻ, ước tính VAT/PIT, việc kê khai và nguồn quy định; số liệu cần xác nhận với cơ quan thuế."
    }
    fn parameters(&self) -> Value {
        schema(
            json!({"year":{"type":"integer","minimum":2026,"maximum":9999},"period":{"type":"string","enum":["month","quarter"]}}),
            json!(["year", "period"]),
        )
    }
    fn requires(&self) -> Option<Action> {
        Some(Action::Exports)
    }
    fn label_vi(&self) -> &'static str {
        "Đang tổng hợp doanh thu và quy tắc thuế…"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        let args = parse::<Args>(args)?;
        let effective = date(&RULES.effective_from)?;
        if args.year < effective.year() || args.year > ctx.today.year() || args.year > 9999 {
            return Err(invalid());
        }
        let start = NaiveDate::from_ymd_opt(args.year, 1, 1).ok_or_else(invalid)?;
        let end = NaiveDate::from_ymd_opt(args.year, 12, 31).ok_or_else(invalid)?;
        let as_of = ctx.today.min(end);
        let monthly:Vec<(i32,i64)>=sqlx::query_as("SELECT extract(month FROM business_date)::integer,coalesce(sum(total),0)::bigint FROM sales WHERE store_id=$1 AND business_date BETWEEN $2 AND $3 AND status='completed' GROUP BY 1 ORDER BY 1")
            .bind(ctx.actor.store_id).bind(start).bind(as_of).fetch_all(pool(&ctx.state)?).await?;
        let mut months = [0_i64; 12];
        for (month, revenue) in monthly {
            months[month as usize - 1] = revenue;
        }
        let annual = months
            .iter()
            .try_fold(0_i64, |total, value| total.checked_add(*value))
            .ok_or_else(|| ToolError::Failed("revenue overflow".into()))?;
        let projected = i64::try_from(
            i128::from(annual) * i128::from((end - start).num_days() + 1)
                / i128::from((as_of - start).num_days() + 1),
        )
        .map_err(|_| ToolError::Failed("projection overflow".into()))?;
        let selected = band(annual);
        let chunk = match args.period {
            Period::Month => 1,
            Period::Quarter => 3,
        };
        let periods:Vec<_>=months.chunks(chunk).enumerate().map(|(index,values)|{
            let first_month=(index*chunk+1) as u32;
            let last_month=(first_month+chunk as u32-1).min(12);
            let from=NaiveDate::from_ymd_opt(args.year,first_month,1).expect("valid month");
            let to=if last_month==12 {end}else{NaiveDate::from_ymd_opt(args.year,last_month+1,1).expect("valid month").pred_opt().expect("previous day")};
            json!({"period":index+1,"from":from,"to":to,"revenue_dong":values.iter().sum::<i64>()})
        }).collect();
        let mut cumulative = 0_i64;
        let crossing_quarter = months.iter().enumerate().find_map(|(i, revenue)| {
            cumulative += revenue;
            (cumulative > RULES.annual_threshold_dong).then_some(i / 3 + 1)
        });
        let declaration = match selected.filing.as_str() {
            "annual_notification" => &RULES.exempt_declaration_vi,
            "monthly" => &RULES.monthly_declaration_vi,
            _ => &RULES.quarterly_declaration_vi,
        };
        let pit = (selected.pit_method == "revenue").then(|| {
            amount(
                (annual - selected.pit_allowance_dong).max(0),
                selected.pit_basis_points,
            )
        });
        let mut out = ToolOutput::new(
            json!({
                "year":args.year,"period":if chunk==1{"month"}else{"quarter"},"periods":periods,
                "as_of":as_of,"annual_revenue_dong":annual,"projected_annual_revenue_dong":projected,
                "projection_note_vi":"Dự phóng tuyến tính từ doanh thu thực tế và số ngày đã qua trong năm; không điều chỉnh mùa vụ. Năm đã kết thúc dùng doanh thu thực tế.",
                "band":selected,"band_basis":"actual_revenue","estimated_vat_dong":amount(annual,selected.vat_basis_points),
                "estimated_pit_dong":pit,"income_method_note_vi":RULES.income_method_note_vi,
                "declaration_vi":declaration,"threshold_crossed_quarter":crossing_quarter,"einvoice_vi":RULES.einvoice_vi,
                "rule_version":RULES.version,"effective_from":RULES.effective_from,"checked_on":RULES.checked_on,
                "activity":RULES.activity,"presumptive_tax_ended_on":RULES.presumptive_tax_ended_on,
                "regulation_note_vi":RULES.regulation_note_vi,"vat_base_note_vi":RULES.vat_base_note_vi,
                "sources":RULES.sources,"disclaimer_vi":RULES.disclaimer_vi,"truncated":false,
            }),
            "Đã tổng hợp doanh thu và quy tắc thuế tham khảo; hãy xác nhận với cơ quan thuế.",
        );
        out.rows = 12 / chunk;
        Ok(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tax_table_parses_and_bands_cover_all_nonnegative_revenue() {
        assert_eq!(RULES.version, "2026.1");
        assert_eq!(RULES.checked_on, "2026-10-25");
        assert_eq!(RULES.bands.first().unwrap().min_revenue_dong, 0);
        assert!(RULES.bands.last().unwrap().max_revenue_dong.is_none());
        for pair in RULES.bands.windows(2) {
            assert_eq!(
                pair[0].max_revenue_dong.unwrap() + 1,
                pair[1].min_revenue_dong
            );
        }
        for b in &RULES.bands {
            assert_eq!(b.confidence, "secondary_sources");
            assert!((0..=10000).contains(&b.vat_basis_points));
            assert!((0..=10000).contains(&b.pit_basis_points));
        }
        assert_eq!(RULES.sources.len(), 5);
        assert_eq!(band(999_999_999).key, "exempt");
        assert_eq!(band(1_000_000_000).key, "exempt");
        assert_eq!(band(1_000_000_001).key, "retail_revenue");
        assert_eq!(band(3_000_000_000).key, "retail_revenue");
        assert_eq!(band(3_000_000_001).key, "income_17");
        assert_eq!(band(50_000_000_001).key, "income_20");
        assert_eq!(band(i64::MAX).key, "income_20");
        assert_eq!(amount(1_000_000_001, 100), 10_000_000);
    }
}
