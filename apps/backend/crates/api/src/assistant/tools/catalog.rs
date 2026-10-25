//! Catalog and store tools: get_store_overview (T1) and get_catalog_issues (batch T5).
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput, vnd};
use crate::{auth::Action, auth::data::pool};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(StoreOverview)]
}

/// Store name, head counts and today's takings in one query.
struct StoreOverview;
#[async_trait]
impl Tool for StoreOverview {
    fn name(&self) -> &'static str {
        "get_store_overview"
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        "Tổng quan cửa hàng: tên cửa hàng, số thành viên, số sản phẩm, số mặt hàng sắp hết \
         và số đơn, doanh thu hôm nay."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn requires(&self) -> Option<Action> {
        None
    }
    fn label_vi(&self) -> &'static str {
        "Đang xem tổng quan cửa hàng…"
    }
    async fn run(&self, ctx: &ToolContext, _args: Value) -> Result<ToolOutput, ToolError> {
        let (name, members, products, low_stock, sales, revenue): (String, i64, i64, i64, i64, i64) =
            sqlx::query_as(
                "SELECT s.name,
                    (SELECT count(*) FROM members m WHERE m.store_id=s.id AND m.active),
                    (SELECT count(*) FROM products p WHERE p.store_id=s.id AND NOT p.archived),
                    (SELECT count(*) FROM products p WHERE p.store_id=s.id AND NOT p.archived
                        AND p.stock_quantity IS NOT NULL
                        AND p.stock_quantity <= coalesce(p.low_stock_threshold, s.low_stock_threshold)),
                    (SELECT count(*) FROM sales x WHERE x.store_id=s.id AND x.business_date=$2
                        AND x.status='completed'),
                    (SELECT coalesce(sum(x.total),0)::bigint FROM sales x WHERE x.store_id=s.id
                        AND x.business_date=$2 AND x.status='completed')
                 FROM stores s WHERE s.id=$1",
            )
            .bind(ctx.actor.store_id)
            .bind(ctx.today)
            .fetch_optional(pool(&ctx.state)?)
            .await?
            .ok_or_else(|| ToolError::NotFound("store".into()))?;
        let summary_vi = format!(
            "{name}: {products} sản phẩm, {low_stock} mặt hàng sắp hết; hôm nay {sales} đơn, doanh thu {}",
            vnd(revenue)
        );
        Ok(ToolOutput::new(
            json!({
                "store_name": name,
                "member_count": members,
                "product_count": products,
                "low_stock_count": low_stock,
                "today": {"date": ctx.today, "sale_count": sales, "revenue": revenue},
            }),
            summary_vi,
        ))
    }
}
