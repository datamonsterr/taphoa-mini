//! Sales read tools. Revenue/voids use sale headers, units use the line's base-unit snapshot.
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput, holidays, queries::*};
use crate::auth::{self, Action, data::pool};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;

enum Sales {
    Summary,
    Top,
    Search,
    Margin,
    Forecast,
    Expenses,
}
pub fn all() -> Vec<Arc<dyn Tool>> {
    [
        Sales::Summary,
        Sales::Top,
        Sales::Search,
        Sales::Margin,
        Sales::Forecast,
        Sales::Expenses,
    ]
    .into_iter()
    .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
    .collect()
}
#[async_trait]
impl Tool for Sales {
    fn name(&self) -> &'static str {
        match self {
            Self::Summary => "get_sales_summary",
            Self::Top => "get_top_products",
            Self::Search => "search_sales",
            Self::Margin => "get_margin_report",
            Self::Forecast => "forecast_demand",
            Self::Expenses => "list_expenses",
        }
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        match self {
            Self::Summary => {
                "Xem doanh thu, số đơn, đơn hủy theo ngày, tuần hoặc thành viên và so với kỳ trước cùng độ dài. Lợi nhuận dùng giá vốn hiện tại như báo cáo ứng dụng; bỏ qua dòng chưa biết giá vốn, lược bỏ lợi nhuận nếu không có quyền đổi giá."
            }
            Self::Top => {
                "Xem sản phẩm bán chạy theo số lượng đơn vị cơ sở hoặc doanh thu, kèm biểu đồ."
            }
            Self::Search => {
                "Tra các dòng bán theo ngày, tên sản phẩm hoặc thành viên; gồm hàng ngoài danh mục, không gồm đơn hủy."
            }
            Self::Margin => {
                "Tìm sản phẩm có biên lợi nhuận thấp hoặc âm theo giá nhập gần nhất và giá bán, gợi ý giá làm tròn lên 500 đồng. Cần quyền đổi giá."
            }
            Self::Forecast => {
                "Dự báo nhu cầu từ thứ trong tuần của 8 tuần gần nhất, xu hướng 14 ngày và hệ số ngày lễ mang tính ước lượng. Không có từ khóa thì lấy 20 sản phẩm có nhu cầu dự kiến cao nhất."
            }
            Self::Expenses => {
                "Tra chi phí theo khoảng ngày và loại chi, tổng từng loại; bỏ qua khoản đã xóa. Cần quyền thêm chi phí."
            }
        }
    }
    fn parameters(&self) -> Value {
        match self {
            Self::Summary => ranged(
                json!({"group_by":{"type":"string","enum":["day","week","member"],"default":"day","description":"Nhóm theo ngày, tuần bắt đầu thứ Hai hoặc thành viên."}}),
            ),
            Self::Top => ranged(
                json!({"metric":{"type":"string","enum":["units","revenue"],"default":"revenue","description":"Xếp theo số đơn vị cơ sở hoặc doanh thu."},"limit":{"type":"integer","minimum":1,"maximum":50,"default":10,"description":"Số sản phẩm tối đa."}}),
            ),
            Self::Search => ranged(
                json!({"product_query":{"type":"string","minLength":1,"maxLength":120,"description":"Tên sản phẩm hoặc nhãn hàng ngoài danh mục, không phân biệt dấu."},"member":{"type":"string","minLength":1,"maxLength":120,"description":"Tên hiển thị hoặc mã thành viên."}}),
            ),
            Self::Margin => schema(
                json!({"min_margin_pct":{"type":"number","minimum":0,"exclusiveMaximum":100,"default":10,"description":"Biên lợi nhuận tối thiểu, phần trăm doanh thu."}}),
                &[],
            ),
            Self::Forecast => schema(
                json!({"days":{"type":"integer","minimum":1,"maximum":14,"description":"Số ngày dự báo, bắt đầu ngày mai."},"product_query":{"type":"string","minLength":1,"maxLength":120,"description":"Tên sản phẩm không phân biệt dấu; bỏ trống lấy 20 sản phẩm."}}),
                &["days"],
            ),
            Self::Expenses => ranged(
                json!({"category":{"type":"string","enum":["nhap_hang","dien","nuoc","khac"],"description":"Loại chi: nhập hàng, điện, nước hoặc khác."}}),
            ),
        }
    }
    fn requires(&self) -> Option<Action> {
        match self {
            Self::Margin => Some(Action::ChangePrice),
            Self::Expenses => Some(Action::AddExpense),
            _ => None,
        }
    }
    fn label_vi(&self) -> &'static str {
        match self {
            Self::Summary => "Đang xem doanh thu…",
            Self::Top => "Đang xem sản phẩm bán chạy…",
            Self::Search => "Đang tra đơn bán…",
            Self::Margin => "Đang kiểm tra lợi nhuận…",
            Self::Forecast => "Đang dự báo nhu cầu…",
            Self::Expenses => "Đang xem chi phí…",
        }
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        if let Some(action) = self.requires() {
            ctx.actor.require(action)?;
        }
        validate(&args, &self.parameters())?;
        match self {
            Self::Summary => summary(ctx, &args).await,
            Self::Top => top(ctx, &args).await,
            Self::Search => search(ctx, &args).await,
            Self::Margin => margin(ctx, &args).await,
            Self::Forecast => forecast(ctx, &args).await,
            Self::Expenses => expenses(ctx, &args).await,
        }
    }
}

// Match reports/top-products: current cost_price, completed lines only. Unknown costs are not
// invented; count those lines separately. Header totals keep manual lines and count each sale once.
macro_rules! summary_base {
    () => {r#"
WITH selected AS (
    SELECT s.*,m.display_name,
        (SELECT sum(l.line_total-l.quantity::bigint*l.quantity_in_base*p.cost_price)::bigint
         FROM sale_lines l JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
         WHERE l.sale_id=s.id AND l.store_id=s.store_id) profit,
        (SELECT count(*) FROM sale_lines l LEFT JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
         WHERE l.sale_id=s.id AND l.store_id=s.store_id AND p.cost_price IS NULL) unpriced
    FROM sales s JOIN members m ON m.id=s.member_id AND m.store_id=s.store_id
    WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3
)
"#};
}
macro_rules! totals {
    () => {
        r#"
SELECT jsonb_build_object(
    'revenue_dong',COALESCE(sum(total) FILTER (WHERE status='completed'),0)::bigint,
    'credit_dong',COALESCE(sum(credit_amount) FILTER (WHERE status='completed'),0)::bigint,
    'sale_count',count(*) FILTER (WHERE status='completed'),
    'void_count',count(*) FILTER (WHERE status='voided'),
    'gross_profit_dong',COALESCE(sum(profit) FILTER (WHERE status='completed'),0)::bigint,
    'profit_unpriced_lines',COALESCE(sum(unpriced) FILTER (WHERE status='completed'),0)::bigint
) FROM selected
"#
    };
}
async fn summary(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let (from, to) = range(ctx, args)?;
    let previous_from = shift(from, -((to - from).num_days() + 1))?;
    let previous_to = shift(from, -1)?;
    let db = pool(&ctx.state)?;
    let sql = concat!(summary_base!(), totals!());
    let mut totals: Value = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(from)
        .bind(to)
        .fetch_one(db)
        .await?;
    let mut previous: Value = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(previous_from)
        .bind(previous_to)
        .fetch_one(db)
        .await?;
    let group_by = text(args, "group_by").unwrap_or("day");
    let sql = concat!(
        summary_base!(),
        r#"
        SELECT to_jsonb(r) FROM (
            SELECT CASE WHEN $4='member' THEN member_id::text
                WHEN $4='week' THEN date_trunc('week',business_date::timestamp)::date::text
                ELSE business_date::text END bucket,
                CASE WHEN $4='member' THEN display_name ELSE NULL END member_name,
                COALESCE(sum(total) FILTER (WHERE status='completed'),0)::bigint revenue_dong,
                COALESCE(sum(credit_amount) FILTER (WHERE status='completed'),0)::bigint credit_dong,
                count(*) FILTER (WHERE status='completed') sale_count,
                count(*) FILTER (WHERE status='voided') void_count,
                COALESCE(sum(profit) FILTER (WHERE status='completed'),0)::bigint gross_profit_dong,
                COALESCE(sum(unpriced) FILTER (WHERE status='completed'),0)::bigint profit_unpriced_lines
            FROM selected GROUP BY bucket,member_name ORDER BY bucket LIMIT 51
        ) r"#
    );
    let groups: Vec<Value> = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(from)
        .bind(to)
        .bind(group_by)
        .fetch_all(db)
        .await?;
    let (mut groups, truncated) = capped(groups, 50);
    let can_cost = auth::can(&ctx.actor, Action::ChangePrice);
    if !can_cost {
        hide_profit(&mut totals);
        hide_profit(&mut previous);
        for group in &mut groups {
            hide_profit(group);
        }
    }
    let mut change = json!({});
    for (name, field) in [
        ("revenue", "revenue_dong"),
        ("sale_count", "sale_count"),
        ("void_count", "void_count"),
        ("gross_profit", "gross_profit_dong"),
    ] {
        if let (Some(current), Some(old)) = (totals[field].as_i64(), previous[field].as_i64()) {
            change[name] = if old == 0 {
                Value::Null
            } else {
                json!((current as f64 - old as f64) / (old as f64).abs() * 100.0)
            };
        }
    }
    let rows = groups.len();
    let summary = format!(
        "{} đơn, doanh thu {}",
        totals["sale_count"],
        super::vnd(totals["revenue_dong"].as_i64().unwrap())
    );
    Ok(output(
        json!({"from":from,"to":to,"group_by":group_by,"totals":totals,"groups":groups,
        "previous":{"from":previous_from,"to":previous_to,"totals":previous},"change_pct":change}),
        rows,
        truncated,
        summary,
    ))
}
async fn top(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let (from, to) = range(ctx, args)?;
    let limit = integer(args, "limit", 10);
    let units = text(args, "metric") == Some("units");
    let items:Vec<Value>=sqlx::query_scalar(r#"
        SELECT to_jsonb(r) FROM (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,
                sum(l.quantity::bigint*l.quantity_in_base)::bigint units,sum(l.line_total)::bigint revenue_dong
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 AND s.status='completed'
            GROUP BY p.id ORDER BY CASE WHEN $4 THEN sum(l.quantity::bigint*l.quantity_in_base) ELSE sum(l.line_total) END DESC,p.id LIMIT $5
        ) r"#).bind(ctx.actor.store_id).bind(from).bind(to).bind(units).bind(limit+1).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items_output(items, limit as usize, "sản phẩm bán chạy");
    let bars: Vec<_> = out.data["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| json!({"label":r["name"],"value":r[if units {"units"}else{"revenue_dong"}]}))
        .collect();
    out.card = Some(
        json!({"type":"chart_bars","title_vi":"Sản phẩm bán chạy","unit":if units {"units"}else{"dong"},"bars":bars}),
    );
    Ok(out)
}
async fn search(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let (from, to) = range(ctx, args)?;
    let result:Value=sqlx::query_scalar(r#"
        WITH matched AS (
            SELECT s.id sale_id,l.product_id,COALESCE(p.name,'hàng ngoài danh mục') name,
                l.quantity::bigint*l.quantity_in_base units,l.line_total
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            LEFT JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
            JOIN members m ON m.id=s.member_id AND m.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 AND s.status='completed'
                AND ($4::text IS NULL OR immutable_unaccent(lower(COALESCE(p.name,l.manual_label,'hàng ngoài danh mục'))) LIKE '%'||immutable_unaccent(lower($4))||'%')
                AND ($5::text IS NULL OR m.id::text=$5 OR immutable_unaccent(lower(m.display_name)) LIKE '%'||immutable_unaccent(lower($5))||'%')
        ), items AS (
            SELECT product_id,name,sum(units)::bigint units,sum(line_total)::bigint revenue_dong,count(DISTINCT sale_id) sale_count
            FROM matched GROUP BY product_id,name ORDER BY revenue_dong DESC,product_id NULLS LAST LIMIT 51
        ) SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM items i),'[]'::jsonb),
            'sale_count',(SELECT count(DISTINCT sale_id) FROM matched))
    "#).bind(ctx.actor.store_id).bind(from).bind(to).bind(text(args,"product_query")).bind(text(args,"member")).fetch_one(pool(&ctx.state)?).await?;
    let mut out = items_output(
        result["items"].as_array().unwrap().clone(),
        50,
        "mặt hàng đã bán",
    );
    out.data["sale_count"] = result["sale_count"].clone();
    Ok(out)
}
async fn margin(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let min = args["min_margin_pct"].as_f64().unwrap_or(10.0);
    let sql = concat!(
        purchase_cte!(),
        r#"
        SELECT to_jsonb(r) FROM (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,c.unit_cost_dong,p.price price_dong,
                CASE WHEN p.price=0 THEN NULL ELSE round((p.price::numeric-c.unit_cost_dong)*100/p.price,2)::float8 END margin_pct,
                (ceil(c.unit_cost_dong::numeric / (1-$3::float8::numeric/100) / 500)*500)::bigint suggested_price_dong
            FROM products p JOIN latest c ON c.product_id=p.id
            WHERE p.store_id=$1 AND NOT p.archived AND
                ((p.price=0 AND c.unit_cost_dong>0) OR (p.price>0 AND (p.price::numeric-c.unit_cost_dong)*100 < p.price::numeric*$3::float8::numeric))
            ORDER BY (p.price::numeric-c.unit_cost_dong)/NULLIF(p.price,0) NULLS FIRST,p.id LIMIT 51
        ) r"#
    );
    let items = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(ctx.today)
        .bind(min)
        .fetch_all(pool(&ctx.state)?)
        .await?;
    Ok(items_output(items, 50, "sản phẩm có biên lợi nhuận thấp"))
}
async fn expenses(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let (from, to) = range(ctx, args)?;
    let result:Value=sqlx::query_scalar(r#"
        WITH selected AS (
            SELECT * FROM expenses WHERE store_id=$1 AND business_date BETWEEN $2 AND $3
                AND deleted_at IS NULL AND ($4::text IS NULL OR category=$4)
        ), items AS (
            SELECT business_date date,category,amount amount_dong,paid_with,note FROM selected ORDER BY spent_at DESC,id DESC LIMIT 51
        ), totals AS (SELECT category,sum(amount)::bigint amount FROM selected GROUP BY category)
        SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM items i),'[]'::jsonb),
            'totals_by_category_dong',COALESCE((SELECT jsonb_object_agg(category,amount) FROM totals),'{}'::jsonb))
    "#).bind(ctx.actor.store_id).bind(from).bind(to).bind(text(args,"category")).fetch_one(pool(&ctx.state)?).await?;
    let mut out = items_output(result["items"].as_array().unwrap().clone(), 50, "khoản chi");
    out.data["totals_by_category_dong"] = result["totals_by_category_dong"].clone();
    Ok(out)
}
async fn forecast(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let count = integer(args, "days", 7);
    let mut dates = Vec::new();
    let mut factors = Vec::new();
    let mut names = Vec::new();
    for i in 1..=count {
        let date = shift(ctx.today, i)?;
        let (factor, name) = holidays::uplift(date);
        dates.push(date);
        factors.push(factor);
        names.push(name.map(str::to_owned));
    }
    let limit: i64 = if text(args, "product_query").is_some() {
        50
    } else {
        20
    };
    let items:Vec<Value>=sqlx::query_scalar(r#"
        WITH daily AS (
            SELECT l.product_id,s.business_date,sum(l.quantity::bigint*l.quantity_in_base)::float8 units
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            WHERE s.store_id=$1 AND s.status='completed' AND s.business_date BETWEEN $2::date-55 AND $2
                AND l.product_id IS NOT NULL GROUP BY l.product_id,s.business_date
        ), profiles AS (
            SELECT product_id,extract(isodow FROM business_date)::int weekday,sum(units)/8.0 units
            FROM daily GROUP BY product_id,weekday
        ), trends AS (
            SELECT product_id,CASE
                WHEN COALESCE(sum(units) FILTER (WHERE business_date < $2::date-13),0)=0 THEN
                    CASE WHEN COALESCE(sum(units) FILTER (WHERE business_date >= $2::date-13),0)>0 THEN 2.0 ELSE 1.0 END
                ELSE greatest(0.5,least(2.0,COALESCE(sum(units) FILTER (WHERE business_date >= $2::date-13),0)
                    /sum(units) FILTER (WHERE business_date < $2::date-13))) END trend
            FROM daily WHERE business_date >= $2::date-27 GROUP BY product_id
        ), future AS (SELECT * FROM unnest($4::date[],$5::float8[],$6::text[]) AS d(date,uplift,holiday)),
        estimates AS (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,COALESCE(t.trend,1.0) trend,
                f.date,f.uplift,f.holiday,COALESCE(w.units,0)*COALESCE(t.trend,1.0)*f.uplift expected_units
            FROM products p CROSS JOIN future f LEFT JOIN trends t ON t.product_id=p.id
            LEFT JOIN profiles w ON w.product_id=p.id AND w.weekday=extract(isodow FROM f.date)::int
            WHERE p.store_id=$1 AND NOT p.archived AND ($3::text IS NULL OR immutable_unaccent(lower(p.name)) LIKE '%'||immutable_unaccent(lower($3))||'%')
        ), ranked AS (
            SELECT product_id,name,trend,sum(expected_units) expected_units,
                jsonb_agg(jsonb_build_object('date',date,'expected_units',expected_units,'uplift',uplift,'holiday',holiday) ORDER BY date) days
            FROM estimates GROUP BY product_id,name,trend ORDER BY expected_units DESC,product_id LIMIT $7
        ) SELECT to_jsonb(r) FROM ranked r
    "#).bind(ctx.actor.store_id).bind(ctx.today).bind(text(args,"product_query"))
        .bind(dates).bind(factors).bind(names).bind(limit+1).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items_output(items, limit as usize, "sản phẩm được dự báo (ước lượng)");
    out.data["history_from"] = json!(shift(ctx.today, -55)?);
    out.data["history_to"] = json!(ctx.today);
    out.data["heuristic"] = json!(true);
    Ok(out)
}
