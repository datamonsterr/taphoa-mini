//! Stock tools use effective store/product thresholds and base-unit purchase/sale quantities.
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput, queries::*};
use crate::auth::{self, Action, data::pool};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

enum Stock {
    Search,
    Levels,
    Restock,
    Dead,
    Suppliers,
}
pub fn all() -> Vec<Arc<dyn Tool>> {
    [
        Stock::Search,
        Stock::Levels,
        Stock::Restock,
        Stock::Dead,
        Stock::Suppliers,
    ]
    .into_iter()
    .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
    .collect()
}
#[async_trait]
impl Tool for Stock {
    fn name(&self) -> &'static str {
        match self {
            Self::Search => "search_products",
            Self::Levels => "get_stock_levels",
            Self::Restock => "get_restock_plan",
            Self::Dead => "get_dead_stock",
            Self::Suppliers => "get_supplier_prices",
        }
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        match self {
            Self::Search => {
                "Tìm sản phẩm đang bán theo tên không phân biệt dấu; xem giá bán, tồn kho, đơn vị và danh mục."
            }
            Self::Levels => {
                "Xem tồn kho thấp, âm, chưa theo dõi hoặc tất cả; dùng ngưỡng riêng của sản phẩm hoặc ngưỡng cửa hàng."
            }
            Self::Restock => {
                "Lập danh sách nhập hàng từ tồn kho, ngưỡng và tốc độ bán 14 ngày, nhóm theo nhà cung cấp gần nhất. Lược bỏ giá vốn và tổng tiền nếu không có quyền đổi giá; thẻ danh sách có các trường tiền rỗng. Hóa đơn thiếu tên nhà cung cấp được ghi rõ là không rõ."
            }
            Self::Dead => {
                "Tìm sản phẩm đang theo dõi còn tồn nhưng không bán trong số ngày yêu cầu; xem lần bán cuối. Lược bỏ tiền tồn nếu không có quyền đổi giá."
            }
            Self::Suppliers => {
                "So sánh lịch sử giá nhập theo sản phẩm và nhà cung cấp, mới nhất trước; chỉ ra giá thấp nhất trong 90 ngày gần nhất. Hóa đơn thiếu tên nhà cung cấp được ghi rõ là không rõ. Cần quyền đổi giá."
            }
        }
    }
    fn parameters(&self) -> Value {
        match self {
            Self::Search => schema(
                json!({"query":{"type":"string","minLength":1,"maxLength":120,"description":"Tên sản phẩm cần tìm, không phân biệt dấu."},"limit":{"type":"integer","minimum":1,"maximum":50,"default":10,"description":"Số sản phẩm tối đa."}}),
                &["query"],
            ),
            Self::Levels => schema(
                json!({"filter":{"type":"string","enum":["low","negative","untracked","all"],"default":"all","description":"Tồn thấp (gồm hết hàng), âm, chưa theo dõi hoặc tất cả."}}),
                &[],
            ),
            Self::Restock => schema(
                json!({"horizon_days":{"type":"integer","minimum":1,"maximum":30,"default":7,"description":"Số ngày cần dự trữ hàng."}}),
                &[],
            ),
            Self::Dead => schema(
                json!({"days":{"type":"integer","minimum":1,"maximum":36500,"default":30,"description":"Số ngày gần nhất không có bán, tính cả hôm nay."}}),
                &[],
            ),
            Self::Suppliers => schema(
                json!({"product_query":{"type":"string","minLength":1,"maxLength":120,"description":"Tên sản phẩm cần so giá, không phân biệt dấu."}}),
                &["product_query"],
            ),
        }
    }
    fn requires(&self) -> Option<Action> {
        if matches!(self, Self::Suppliers) {
            Some(Action::ChangePrice)
        } else {
            None
        }
    }
    fn label_vi(&self) -> &'static str {
        match self {
            Self::Search => "Đang tìm sản phẩm…",
            Self::Levels => "Đang xem tồn kho…",
            Self::Restock => "Đang lập danh sách nhập hàng…",
            Self::Dead => "Đang tìm hàng tồn lâu…",
            Self::Suppliers => "Đang so sánh giá nhập…",
        }
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        if let Some(action) = self.requires() {
            ctx.actor.require(action)?;
        }
        validate(&args, &self.parameters())?;
        match self {
            Self::Search => search(ctx, &args).await,
            Self::Levels => levels(ctx, &args).await,
            Self::Restock => restock(ctx, &args).await,
            Self::Dead => dead(ctx, &args).await,
            Self::Suppliers => suppliers(ctx, &args).await,
        }
    }
}
async fn search(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let limit = integer(args, "limit", 10);
    let items=sqlx::query_scalar(r#"
        SELECT to_jsonb(r) FROM (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,p.price price_dong,p.stock_quantity,
                p.base_unit unit,c.name category
            FROM products p LEFT JOIN categories c ON c.id=p.category_id AND c.store_id=p.store_id
            WHERE p.store_id=$1 AND NOT p.archived AND immutable_unaccent(lower(p.name)) LIKE '%'||immutable_unaccent(lower($2))||'%'
            ORDER BY lower(p.name),p.id LIMIT $3
        ) r"#).bind(ctx.actor.store_id).bind(text(args,"query")).bind(limit+1).fetch_all(pool(&ctx.state)?).await?;
    Ok(items_output(items, limit as usize, "sản phẩm"))
}
async fn levels(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let items=sqlx::query_scalar(r#"
        SELECT to_jsonb(r) FROM (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,p.stock_quantity,
                COALESCE(p.low_stock_threshold,s.low_stock_threshold) threshold,
                CASE WHEN p.stock_quantity IS NULL THEN 'untracked' WHEN p.stock_quantity<=0 THEN 'out'
                    WHEN p.stock_quantity<=COALESCE(p.low_stock_threshold,s.low_stock_threshold) THEN 'low' ELSE 'ok' END status
            FROM products p JOIN stores s ON s.id=p.store_id
            WHERE p.store_id=$1 AND NOT p.archived AND (
                $2='all' OR ($2='untracked' AND p.stock_quantity IS NULL) OR ($2='negative' AND p.stock_quantity<0)
                OR ($2='low' AND p.stock_quantity<=COALESCE(p.low_stock_threshold,s.low_stock_threshold)))
            ORDER BY p.stock_quantity NULLS LAST,p.id LIMIT 51
        ) r"#).bind(ctx.actor.store_id).bind(text(args,"filter").unwrap_or("all")).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items_output(items, 50, "sản phẩm tồn kho");
    let mut counts = BTreeMap::<String, usize>::new();
    for item in out.data["items"].as_array().unwrap() {
        if let Some(status) = item["status"].as_str() {
            *counts.entry(status.into()).or_default() += 1;
        }
    }
    // Counts describe returned rows only, including when the result was capped.
    out.data["returned_status_counts"] = json!(counts);
    Ok(out)
}
async fn restock(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let horizon = integer(args, "horizon_days", 7);
    let sql = concat!(
        purchase_cte!(),
        r#", speed AS (
            SELECT l.product_id,sum(l.quantity::bigint*l.quantity_in_base)::numeric/14 avg
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            WHERE s.store_id=$1 AND s.status='completed' AND s.business_date BETWEEN $2::date-13 AND $2
            GROUP BY l.product_id
        ), candidates AS (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,p.stock_quantity,
                COALESCE(p.low_stock_threshold,s.low_stock_threshold) threshold,COALESCE(v.avg,0) avg,
                greatest(1,ceil(COALESCE(v.avg,0)*$3+COALESCE(p.low_stock_threshold,s.low_stock_threshold)-p.stock_quantity))::bigint suggested_quantity,
                c.unit_cost_dong,COALESCE(c.supplier,'Không rõ nhà cung cấp') supplier,c.supplier IS NULL supplier_missing
            FROM products p JOIN stores s ON s.id=p.store_id LEFT JOIN speed v ON v.product_id=p.id
            LEFT JOIN latest c ON c.product_id=p.id
            WHERE p.store_id=$1 AND NOT p.archived AND p.stock_quantity IS NOT NULL AND
                (p.stock_quantity<=COALESCE(p.low_stock_threshold,s.low_stock_threshold) OR p.stock_quantity<=COALESCE(v.avg,0)*$3)
            ORDER BY p.stock_quantity,p.id LIMIT 51
        ) SELECT jsonb_build_object('product_id',product_id,'name',name,'stock_quantity',stock_quantity,'threshold',threshold,
            'avg_daily_units',avg::float8,'suggested_quantity',suggested_quantity,'supplier',supplier,'supplier_missing',supplier_missing,
            'unit_cost_dong',unit_cost_dong,'line_total_dong',(unit_cost_dong::numeric*suggested_quantity)::bigint) FROM candidates"#
    );
    let items: Vec<Value> = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(ctx.today)
        .bind(horizon)
        .fetch_all(pool(&ctx.state)?)
        .await?;
    let (mut items, truncated) = capped(items, 50);
    let can_cost = auth::can(&ctx.actor, Action::ChangePrice);
    let mut total = Some(0_i64);
    let mut cards = Vec::new();
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let missing = items
        .iter()
        .filter(|i| i["supplier_missing"] == true)
        .count();
    for item in &mut items {
        total = total
            .zip(item["line_total_dong"].as_i64())
            .and_then(|(a, b)| a.checked_add(b));
        cards.push(json!({"product_id":item["product_id"],"name":item["name"],"quantity":item["suggested_quantity"],
            "unit_cost":if can_cost {item["unit_cost_dong"].clone()}else{Value::Null},
            "total_cost":if can_cost {item["line_total_dong"].clone()}else{Value::Null}}));
        if !can_cost {
            let object = item.as_object_mut().unwrap();
            object.remove("unit_cost_dong");
            object.remove("line_total_dong");
        }
        groups
            .entry(item["supplier"].as_str().unwrap().to_owned())
            .or_default()
            .push(item.clone());
    }
    let groups: Vec<_> = groups
        .into_iter()
        .map(|(supplier, items)| json!({"supplier":supplier,"items":items}))
        .collect();
    let rows = items.len();
    let mut summary = format!("{rows} sản phẩm cần nhập");
    if missing > 0 {
        summary.push_str(&format!("; {missing} sản phẩm chưa có tên nhà cung cấp"));
    }
    let mut out = output(
        json!({"items":items,"groups":groups,"horizon_days":horizon,"sales_from":shift(ctx.today,-13)?,
        "sales_to":ctx.today,"supplier_names_missing":missing>0}),
        rows,
        truncated,
        summary,
    );
    if can_cost {
        out.data["grand_total_dong"] = json!(total);
    }
    out.card = Some(
        json!({"type":"restock_list","items":cards,"total_cost":if can_cost {json!(total)}else{Value::Null}}),
    );
    Ok(out)
}
async fn dead(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let days = integer(args, "days", 30);
    let from = shift(ctx.today, 1 - days)?;
    let sql = concat!(
        purchase_cte!(),
        r#", last_sales AS (
            SELECT l.product_id,max(s.business_date) last_sale_date
            FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            WHERE s.store_id=$1 AND s.status='completed' AND s.business_date <= $2 GROUP BY l.product_id
        ) SELECT to_jsonb(r) FROM (
            SELECT p.id product_id,COALESCE(p.name,'Chưa đặt tên') name,p.stock_quantity,v.last_sale_date,
                (p.stock_quantity::numeric*COALESCE(c.unit_cost_dong,p.cost_price))::bigint tied_up_dong
            FROM products p LEFT JOIN last_sales v ON v.product_id=p.id LEFT JOIN latest c ON c.product_id=p.id
            WHERE p.store_id=$1 AND NOT p.archived AND p.stock_quantity>0 AND (v.last_sale_date IS NULL OR v.last_sale_date<$3)
            ORDER BY v.last_sale_date NULLS FIRST,p.id LIMIT 51
        ) r"#
    );
    let mut items: Vec<Value> = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(ctx.today)
        .bind(from)
        .fetch_all(pool(&ctx.state)?)
        .await?;
    if !auth::can(&ctx.actor, Action::ChangePrice) {
        for item in &mut items {
            item.as_object_mut().unwrap().remove("tied_up_dong");
        }
    }
    let mut out = items_output(items, 50, "sản phẩm tồn lâu");
    if auth::can(&ctx.actor, Action::ChangePrice) {
        let costs: Option<Vec<i64>> = out.data["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["tied_up_dong"].as_i64())
            .collect();
        out.data["total_tied_up_dong"] =
            json!(costs.and_then(|v| v.into_iter().try_fold(0_i64, i64::checked_add)));
    }
    out.data["lookback_days"] = json!(days);
    out.data["from"] = json!(from);
    out.data["to"] = json!(ctx.today);
    Ok(out)
}
async fn suppliers(ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
    let sql = concat!(
        purchase_cte!(),
        r#", matched AS (
            SELECT c.*,p.name FROM purchases c JOIN products p ON p.id=c.product_id AND p.store_id=$1
            WHERE immutable_unaccent(lower(p.name)) LIKE '%'||immutable_unaccent(lower($3))||'%'
        ), history AS (
            SELECT product_id,COALESCE(name,'Chưa đặt tên') name,COALESCE(supplier,'Không rõ nhà cung cấp') supplier,
                supplier IS NULL supplier_missing,date,unit_cost_dong FROM matched ORDER BY date DESC,spent_at DESC,id DESC LIMIT 51
        ), cheapest AS (
            SELECT DISTINCT ON (product_id) product_id,COALESCE(supplier,'Không rõ nhà cung cấp') supplier,
                supplier IS NULL supplier_missing,date,unit_cost_dong FROM matched WHERE date >= $2::date-89
            ORDER BY product_id,unit_cost_dong,date DESC,id DESC
        ) SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM history h),'[]'::jsonb),
            'cheapest',COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM (SELECT * FROM cheapest ORDER BY product_id LIMIT 51) c),'[]'::jsonb),
            'supplier_names_missing',EXISTS(SELECT 1 FROM matched WHERE supplier IS NULL))"#
    );
    let result: Value = sqlx::query_scalar(sql)
        .bind(ctx.actor.store_id)
        .bind(ctx.today)
        .bind(text(args, "product_query"))
        .fetch_one(pool(&ctx.state)?)
        .await?;
    let mut out = items_output(
        result["items"].as_array().unwrap().clone(),
        50,
        "dòng giá nhập",
    );
    let (cheapest, more) = capped(result["cheapest"].as_array().unwrap().clone(), 50);
    let mut suppliers = BTreeMap::<String, usize>::new();
    for item in out.data["items"].as_array_mut().unwrap() {
        *suppliers
            .entry(item["supplier"].as_str().unwrap().to_owned())
            .or_default() += 1;
        if let Some(low) = cheapest
            .iter()
            .find(|c| c["product_id"] == item["product_id"])
        {
            item["premium_over_cheapest_dong"] = json!(
                item["unit_cost_dong"].as_i64().unwrap() - low["unit_cost_dong"].as_i64().unwrap()
            );
        }
    }
    out.data["returned_supplier_count"] = json!(suppliers.len());
    out.data["returned_purchases_by_supplier"] = json!(suppliers);
    out.data["cheapest"] = json!(cheapest);
    out.data["cheapest_lookback_days"] = json!(90);
    out.data["supplier_names_missing"] = result["supplier_names_missing"].clone();
    if more {
        out.truncated = true;
        out.data["truncated"] = json!(true);
    }
    if result["supplier_names_missing"] == true {
        out.summary_vi
            .push_str("; có hóa đơn thiếu tên nhà cung cấp");
        out.data["summary_vi"] = json!(out.summary_vi);
    }
    Ok(out)
}
