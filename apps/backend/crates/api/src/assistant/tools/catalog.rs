//! Catalog and store tools: get_store_overview (T1) and get_catalog_issues (batch T5).
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput, vnd};
use crate::{auth::Action, auth::data::pool};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(StoreOverview), Arc::new(CatalogIssues)]
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

struct CatalogIssues;
#[async_trait]
impl Tool for CatalogIssues {
    fn name(&self) -> &'static str {
        "get_catalog_issues"
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        "Dùng khi cần dọn danh mục: tên hoặc mã vạch trùng, thiếu nhóm, giá bằng 0, thiếu ảnh hoặc dưới 3 ảnh tham chiếu."
    }
    fn parameters(&self) -> Value {
        super::ops::schema(json!({}), json!([]))
    }
    fn requires(&self) -> Option<Action> {
        None
    }
    fn label_vi(&self) -> &'static str {
        "Đang kiểm tra danh mục…"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        super::ops::parse::<super::ops::Empty>(args)?;
        let rows=sqlx::query_scalar(r#"
            WITH catalog AS MATERIALIZED (
                SELECT p.*,trim(regexp_replace(immutable_unaccent(lower(coalesce(p.name,''))),'[^a-z0-9]+',' ','g')) normalized_name,
                    (SELECT count(*) FROM product_images pi WHERE pi.product_id=p.id) reference_count
                FROM products p WHERE p.store_id=$1 AND NOT p.archived
            ), barcodes AS (
                SELECT id product_id,barcode FROM catalog WHERE barcode IS NOT NULL AND barcode<>''
                UNION SELECT u.product_id,u.barcode FROM product_units u JOIN catalog p ON p.id=u.product_id
                    WHERE u.store_id=$1 AND u.barcode IS NOT NULL AND u.barcode<>''
            ), issues AS (
                SELECT p.*,array_remove(ARRAY[
                    CASE WHEN (p.normalized_name<>'' AND EXISTS(SELECT 1 FROM catalog q WHERE q.id<>p.id AND q.normalized_name=p.normalized_name))
                        OR EXISTS(SELECT 1 FROM barcodes a JOIN barcodes b ON a.barcode=b.barcode AND a.product_id<>b.product_id WHERE a.product_id=p.id)
                        THEN 'possible_duplicate' END,
                    CASE WHEN p.category_id IS NULL THEN 'missing_category' END,
                    CASE WHEN p.price=0 THEN 'missing_price' END,
                    CASE WHEN p.reference_count=0 THEN 'no_photos' END,
                    CASE WHEN p.reference_count<3 THEN 'few_references' END],NULL) issues FROM catalog p
            ) SELECT jsonb_build_object('product_id',id,'name',name,'barcode',barcode,'price_dong',price,
                'reference_count',reference_count,'issues',issues) FROM issues
            WHERE cardinality(issues)>0 ORDER BY id LIMIT 51
        "#).bind(ctx.actor.store_id).fetch_all(pool(&ctx.state)?).await?;
        let mut out = super::ops::items(rows, 50, "Sản phẩm cần kiểm tra danh mục");
        out.data["note_vi"] = json!(
            "Giá luôn có trong dữ liệu; giá bằng 0 được đánh dấu cần kiểm tra, không khẳng định là sai."
        );
        Ok(out)
    }
}
