//! Store operations read tools. Queries follow the existing report and receipt handlers.
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput};
use crate::auth::{Action, data::pool};
use async_trait::async_trait;
use chrono::NaiveDate;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub fn all() -> Vec<Arc<dyn Tool>> {
    [
        Op::DayClose,
        Op::Review,
        Op::Matches,
        Op::Recognition,
        Op::Members,
        Op::Anomalies,
        Op::Thresholds,
        Op::Setup,
        Op::Receipt,
        Op::Export,
    ]
    .into_iter()
    .map(|op| Arc::new(op) as Arc<dyn Tool>)
    .collect()
}

pub(super) fn invalid() -> ToolError {
    ToolError::InvalidArguments("invalid tool arguments".into())
}
pub(super) fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ToolError> {
    serde_json::from_value(args).map_err(|_| invalid())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}
pub(super) fn date(raw: &str) -> Result<NaiveDate, ToolError> {
    if raw.len() != 10 {
        return Err(invalid());
    }
    raw.parse::<NaiveDate>()
        .ok()
        .filter(|d| d.to_string() == raw)
        .ok_or_else(invalid)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    from: String,
    to: String,
}
impl Range {
    fn dates(self) -> Result<(NaiveDate, NaiveDate), ToolError> {
        let (from, to) = (date(&self.from)?, date(&self.to)?);
        if from > to {
            return Err(invalid());
        }
        Ok((from, to))
    }
}
pub(super) fn schema(properties: Value, required: Value) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn range_properties() -> Value {
    json!({"from":{"type":"string","format":"date"},"to":{"type":"string","format":"date"}})
}
pub(super) fn items(mut rows: Vec<Value>, cap: usize, summary: &str) -> ToolOutput {
    let truncated = rows.len() > cap;
    rows.truncate(cap);
    let len = rows.len();
    let mut out = ToolOutput::new(
        json!({"items":rows,"truncated":truncated}),
        format!("{summary}: {len} mục."),
    );
    out.rows = len;
    out.truncated = truncated;
    out
}
#[derive(Clone, Copy)]
enum Op {
    DayClose,
    Review,
    Matches,
    Recognition,
    Members,
    Anomalies,
    Thresholds,
    Setup,
    Receipt,
    Export,
}
#[async_trait]
impl Tool for Op {
    fn name(&self) -> &'static str {
        match self {
            Self::DayClose => "explain_day_close",
            Self::Review => "list_review_queue",
            Self::Matches => "suggest_manual_line_matches",
            Self::Recognition => "get_recognition_health",
            Self::Members => "get_member_activity",
            Self::Anomalies => "detect_anomalies",
            Self::Thresholds => "suggest_low_stock_thresholds",
            Self::Setup => "get_setup_checklist",
            Self::Receipt => "get_receipt",
            Self::Export => "start_export",
        }
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        match self {
            Self::DayClose => {
                "Xem tiền bán thu bằng tiền mặt và khoản chi khỏi két theo ngày, hoặc giải thích chênh lệch chốt sổ: tiền đầu ngày, hoàn tiền, tiền kỳ vọng và thực đếm. Dùng kể cả khi chỉ hỏi tiền mặt vào/ra, không hỏi lệch quỹ."
            }
            Self::Review => {
                "Dùng khi cần xem các dòng bán thủ công hoặc sai giá đang chờ chủ cửa hàng kiểm tra."
            }
            Self::Matches => {
                "Dùng khi cần gợi ý tối đa 3 sản phẩm cho mỗi dòng chờ kiểm tra, theo tên, giá và nhóm; không tự sửa dòng."
            }
            Self::Recognition => {
                "Báo cáo camera bán hàng: món không nhận ra, bỏ sót, nhận nhầm, số lần nhận diện/sửa và số ảnh mẫu. Dùng get_recognition_health cho chất lượng nhận diện; search_help chỉ hướng dẫn thao tác. Không rõ kỳ thì xem 60 ngày gần đây."
            }
            Self::Members => {
                "Báo cáo hoạt động nhân viên: ai hủy đơn nhiều nhất, hủy mấy đơn, số đơn bán và dòng gõ tay theo từng người trong khoảng ngày. Dùng cả khi chỉ hỏi một người bán bao nhiêu đơn hoặc gõ tay bao nhiêu dòng; get_sales_summary không thay thế công cụ này."
            }
            Self::Anomalies => {
                "Xem số đơn bị hủy trong kỳ, tỷ lệ hủy bất thường, tồn âm, giá đổi trên 30% hoặc bán vào giờ ít gặp."
            }
            Self::Thresholds => {
                "Dùng khi cần gợi ý ngưỡng sắp hết từ tốc độ bán 28 ngày và khoảng cách nhập hàng; chưa thay đổi ngưỡng."
            }
            Self::Setup => {
                "Dùng khi cần kiểm tra VietQR, người bán, quyền thêm hàng, ngưỡng tồn, chốt sổ và danh mục ban đầu."
            }
            Self::Receipt => {
                "Dùng khi cần đọc trạng thái và các dòng hóa đơn nhập, kiểm tra sản phẩm đã khớp trước khi xác nhận."
            }
            Self::Export => {
                "Dùng khi cần đường dẫn tải giao dịch hoặc bảng giá bằng quyền đăng nhập trong ứng dụng; không tạo tệp ở đây."
            }
        }
    }
    fn parameters(&self) -> Value {
        match self {
            Self::DayClose => schema(
                json!({"business_date":{"type":"string","format":"date"}}),
                json!(["business_date"]),
            ),
            Self::Review => schema(
                json!({"limit":{"type":"integer","minimum":1,"maximum":50,"default":20}}),
                json!([]),
            ),
            Self::Matches => schema(
                json!({"manual_line_ids":{"type":"array","minItems":1,"maxItems":20,"uniqueItems":true,"items":{"type":"string","format":"uuid"}}}),
                json!(["manual_line_ids"]),
            ),
            Self::Recognition | Self::Members | Self::Anomalies => {
                schema(range_properties(), json!(["from", "to"]))
            }
            Self::Thresholds | Self::Setup => schema(json!({}), json!([])),
            Self::Receipt => schema(
                json!({"receipt_id":{"type":"string","format":"uuid"}}),
                json!(["receipt_id"]),
            ),
            Self::Export => {
                let mut p = range_properties();
                p["kind"] = json!({"type":"string","enum":["transactions","price_list"]});
                schema(p, json!(["kind", "from", "to"]))
            }
        }
    }
    fn requires(&self) -> Option<Action> {
        Some(match self {
            Self::DayClose => Action::DayClose,
            Self::Review | Self::Matches => Action::ReviewQueue,
            Self::Recognition => Action::RecognitionReport,
            Self::Members => Action::ManageMembers,
            Self::Anomalies => Action::ViewAlerts,
            Self::Thresholds => Action::AdjustStock,
            Self::Setup => Action::ManageStore,
            Self::Receipt => Action::EnrollProduct,
            Self::Export => Action::Exports,
        })
    }
    fn label_vi(&self) -> &'static str {
        match self {
            Self::DayClose => "Đang kiểm tra chốt sổ…",
            Self::Review | Self::Matches => "Đang xem hàng chờ kiểm tra…",
            Self::Recognition => "Đang xem chất lượng nhận diện…",
            Self::Members => "Đang xem hoạt động thành viên…",
            Self::Anomalies => "Đang kiểm tra bất thường…",
            Self::Thresholds => "Đang tính ngưỡng tồn kho…",
            Self::Setup => "Đang kiểm tra cài đặt…",
            Self::Receipt => "Đang đọc hóa đơn nhập…",
            Self::Export => "Đang lấy đường dẫn xuất…",
        }
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        match self {
            Self::DayClose => day_close(ctx, args).await,
            Self::Review => review(ctx, args).await,
            Self::Matches => matches(ctx, args).await,
            Self::Receipt => receipt(ctx, args).await,
            Self::Export => export(ctx, args).await,
            Self::Recognition | Self::Members | Self::Anomalies => {
                let (from, to) = parse::<Range>(args)?.dates()?;
                match self {
                    Self::Recognition => recognition(ctx, from, to).await,
                    Self::Members => members(ctx, from, to).await,
                    _ => anomalies(ctx, from, to).await,
                }
            }
            Self::Thresholds | Self::Setup => {
                parse::<Empty>(args)?;
                if matches!(self, Self::Setup) {
                    setup(ctx).await
                } else {
                    thresholds(ctx).await
                }
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseArgs {
    business_date: String,
}
async fn day_close(ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
    let day = date(&parse::<CloseArgs>(args)?.business_date)?;
    let data:Value=sqlx::query_scalar(r#"
        WITH c AS (SELECT * FROM day_closes WHERE store_id=$1 AND business_date=$2),
        s AS (SELECT coalesce(sum(total-credit_amount) FILTER (WHERE payment_method='cash'),0)::bigint cash_completed,
            coalesce(sum(total-credit_amount) FILTER (WHERE payment_method='transfer'),0)::bigint transfer_revenue,
            coalesce(sum(credit_amount),0)::bigint credit_sales
            FROM sales WHERE store_id=$1 AND business_date=$2 AND status='completed'),
        v AS (SELECT coalesce(sum(total-credit_amount),0)::bigint refunds FROM sales
            WHERE store_id=$1 AND business_date=$2 AND payment_method='cash' AND status='voided'),
        r AS (SELECT coalesce(sum(-amount) FILTER (WHERE method='cash'),0)::bigint cash_repayments,
            coalesce(sum(-amount) FILTER (WHERE method='transfer'),0)::bigint transfer_repayments
            FROM debt_entries WHERE store_id=$1 AND business_date=$2 AND kind='repayment'),
        e AS (SELECT coalesce(sum(amount),0)::bigint expenses FROM expenses
            WHERE store_id=$1 AND business_date=$2 AND deleted_at IS NULL AND paid_with='cash_box')
        SELECT jsonb_build_object('business_date',$2::date,
            'opening_cash_dong',coalesce(c.opening_float,0),
            'cash_sales_dong',coalesce(c.cash_sales,s.cash_completed+v.refunds),
            'cash_refunds_dong',coalesce(c.cash_refunds,v.refunds),
            'credit_sales_dong',coalesce(c.credit_sales,s.credit_sales),
            'debt_repayments_cash_dong',coalesce(c.cash_repayments,r.cash_repayments),
            'debt_repayments_transfer_dong',coalesce(c.transfer_repayments,r.transfer_repayments),
            'cash_expenses_dong',coalesce(c.cash_expenses,e.expenses),
            'transfer_revenue_dong',coalesce(c.transfer_revenue,s.transfer_revenue),
            'expected_cash_dong',coalesce(c.expected_cash,s.cash_completed+r.cash_repayments-e.expenses),
            'close',CASE WHEN c.store_id IS NULL THEN NULL ELSE jsonb_build_object(
                'counted_cash_dong',c.counted_cash,'expected_cash_dong',c.expected_cash,
                'difference_dong',c.difference,'closed_at',c.closed_at,'note',c.note,
                'late_sales_count',(SELECT count(*) FROM sales x WHERE x.store_id=$1
                    AND x.business_date=$2 AND x.status='completed' AND x.received_at>c.closed_at)) END)
        FROM s CROSS JOIN v CROSS JOIN r CROSS JOIN e LEFT JOIN c ON true
    "#).bind(ctx.actor.store_id).bind(day).fetch_one(pool(&ctx.state)?).await?;
    let mut data = data;
    data["note_vi"] = json!(
        "Khi đã chốt, các khoản tiền là ảnh chụp tại lần chốt; khi chưa chốt, tiền đầu ngày mặc định 0 ₫. Doanh số bán chịu không tính vào tiền mặt; tiền trả nợ được tính theo phương thức thanh toán."
    );
    data["cash_equation_vi"] = json!(
        "Tiền mặt kỳ vọng = tiền đầu ngày + bán tiền mặt + trả nợ tiền mặt − hoàn tiền mặt − chi tiền mặt. Không cộng doanh thu chuyển khoản; chênh lệch = tiền đếm − tiền kỳ vọng. Công cụ không xác định được nguyên nhân hụt tiền."
    );
    Ok(ToolOutput::new(data, "Đã kiểm tra số liệu chốt sổ."))
}
fn default_limit() -> usize {
    20
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Limit {
    #[serde(default = "default_limit")]
    limit: usize,
}
async fn review(ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
    let limit = parse::<Limit>(args)?.limit;
    if !(1..=50).contains(&limit) {
        return Err(invalid());
    }
    let rows = sqlx::query_scalar(
        r#"
        SELECT jsonb_build_object('line_id',l.id,'name',coalesce(l.manual_label,p.name,''),
            'unit_price_dong',l.unit_price,'current_price_dong',p.price,
            'unit_price_difference_dong',l.unit_price-p.price,
            'line_price_difference_dong',l.quantity::bigint*(l.unit_price-p.price),
            'quantity',l.quantity,'sale_date',s.business_date,
            'sale_id',s.id,'member_id',m.id,'member_display_name',m.display_name,'source',l.source)
        FROM sale_lines l JOIN sales s ON s.id=l.sale_id AND s.store_id=l.store_id
        JOIN members m ON m.id=s.member_id AND m.store_id=s.store_id
        LEFT JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
        WHERE l.store_id=$1 AND l.review_status='open'
        ORDER BY s.sold_at DESC,l.id DESC LIMIT $2
    "#,
    )
    .bind(ctx.actor.store_id)
    .bind((limit + 1) as i64)
    .fetch_all(pool(&ctx.state)?)
    .await?;
    let mut out = items(rows, limit, "Các dòng đang chờ kiểm tra");
    let (manual, total): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE source='manual'),count(*) FROM sale_lines WHERE store_id=$1 AND review_status='open'",
    ).bind(ctx.actor.store_id).fetch_one(pool(&ctx.state)?).await?;
    out.data["manual_open_count"] = json!(manual);
    out.data["open_line_count"] = json!(total);
    Ok(out)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MatchArgs {
    manual_line_ids: Vec<Uuid>,
}
async fn matches(ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
    let ids = parse::<MatchArgs>(args)?.manual_line_ids;
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    if ids.is_empty() || ids.len() > 20 || ids.len() != unique.len() {
        return Err(invalid());
    }
    let rows:Vec<Value>=sqlx::query_scalar(r#"
        SELECT jsonb_build_object('line_id',l.id,'candidates',coalesce((
            SELECT jsonb_agg(candidate ORDER BY score DESC,product_id) FROM (
                SELECT p.id product_id,
                    jsonb_build_object('product_id',p.id,'name',p.name,'price_dong',p.price,
                        'reasons',array_remove(ARRAY[
                            CASE WHEN overlap.n>0 THEN 'Tên có từ trùng nhau' END,
                            CASE WHEN p.price=l.unit_price THEN 'Cùng giá bán' END,
                            CASE WHEN p.category_id=original.category_id THEN 'Cùng nhóm hàng' END],NULL)) candidate,
                    overlap.n*3+(CASE WHEN p.price=l.unit_price THEN 2 ELSE 0 END)
                        +(CASE WHEN p.category_id=original.category_id THEN 1 ELSE 0 END) score
                FROM products p CROSS JOIN LATERAL (
                    SELECT count(*) n FROM (
                        SELECT unnest(regexp_split_to_array(immutable_unaccent(lower(coalesce(p.name,''))),'[^a-z0-9]+')) token
                        INTERSECT SELECT unnest(regexp_split_to_array(immutable_unaccent(lower(coalesce(l.manual_label,original.name,''))),'[^a-z0-9]+'))
                    ) tokens WHERE token<>''
                ) overlap
                WHERE p.store_id=l.store_id AND NOT p.archived AND
                    (overlap.n>0 OR p.price=l.unit_price OR p.category_id=original.category_id)
                ORDER BY score DESC,p.id LIMIT 3
            ) candidates),'[]'::jsonb))
        FROM unnest($2::uuid[]) WITH ORDINALITY wanted(id,position)
        JOIN sale_lines l ON l.id=wanted.id AND l.store_id=$1 AND l.review_status='open'
        LEFT JOIN products original ON original.id=coalesce(l.product_id,l.review_product_id) AND original.store_id=l.store_id
        ORDER BY wanted.position
    "#).bind(ctx.actor.store_id).bind(&ids).fetch_all(pool(&ctx.state)?).await?;
    if rows.len() != ids.len() {
        return Err(ToolError::NotFound("manual line".into()));
    }
    Ok(items(rows, 50, "Gợi ý khớp danh mục"))
}
async fn recognition(
    ctx: &ToolContext,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<ToolOutput, ToolError> {
    // The linked detections and corrected/unknown predicates match reports::recognition.
    let rows=sqlx::query_scalar(r#"
        WITH linked AS MATERIALIZED (
            SELECT l.product_id,l.suggested_product_id,d.match FROM sales s
            JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            JOIN detections d ON d.id=l.detection_id AND d.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3
        ), counts AS (
            SELECT product_id,count(*) detections,
                count(*) FILTER (WHERE suggested_product_id IS NOT NULL AND suggested_product_id<>product_id) corrected,
                count(*) FILTER (WHERE match='unknown') missed FROM linked GROUP BY product_id
        ), photos AS (SELECT pi.product_id,count(*) reference_count FROM product_images pi
            JOIN products p ON p.id=pi.product_id WHERE p.store_id=$1 GROUP BY pi.product_id)
        SELECT jsonb_build_object('product_id',p.id,'name',p.name,'detections',coalesce(c.detections,0),
            'corrected',coalesce(c.corrected,0),'missed',coalesce(c.missed,0),
            'missed_pct',CASE WHEN c.detections>0 THEN c.missed*100.0/c.detections ELSE 0 END,
            'corrected_pct',CASE WHEN c.detections>0 THEN c.corrected*100.0/c.detections ELSE 0 END,
            'reference_count',coalesce(ph.reference_count,0),
            'confused_with',coalesce((SELECT jsonb_agg(pair ORDER BY pair.count DESC,pair.product_id) FROM (
                SELECT q.id product_id,q.name,count(*) count FROM linked l
                JOIN products q ON q.id=l.suggested_product_id AND q.store_id=$1
                WHERE l.product_id=p.id AND l.suggested_product_id<>l.product_id
                GROUP BY q.id,q.name
            ) pair),'[]'::jsonb))
        FROM products p LEFT JOIN counts c ON c.product_id=p.id LEFT JOIN photos ph ON ph.product_id=p.id
        WHERE p.store_id=$1 AND NOT p.archived AND (coalesce(c.corrected,0)>0 OR coalesce(c.missed,0)>0 OR coalesce(ph.reference_count,0)<3)
        ORDER BY coalesce(c.corrected,0)+coalesce(c.missed,0) DESC,p.id LIMIT 51
    "#).bind(ctx.actor.store_id).bind(from).bind(to).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items(rows, 50, "Sản phẩm cần cải thiện nhận diện");
    out.data["minimum_reference_count"] = json!(3);
    out.data["from"] = json!(from);
    out.data["to"] = json!(to);
    out.data["lookback_days"] = json!((to - from).num_days());
    Ok(out)
}
async fn members(
    ctx: &ToolContext,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<ToolOutput, ToolError> {
    let rows=sqlx::query_scalar(r#"
        WITH activity AS (
            SELECT s.member_id,count(*) FILTER (WHERE s.status='completed') sale_count,
                coalesce(sum(s.total) FILTER (WHERE s.status='completed'),0)::bigint revenue,
                count(*) FILTER (WHERE s.status='voided') voids
            FROM sales s WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 GROUP BY s.member_id
        ), manual AS (
            SELECT s.member_id,count(*) manual_lines FROM sales s JOIN sale_lines l ON l.sale_id=s.id AND l.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 AND l.source='manual' GROUP BY s.member_id
        ) SELECT jsonb_build_object('member_id',m.id,'display_name',m.display_name,'role',m.role,
            'role_vi',CASE WHEN m.role='lead' THEN 'Chủ' ELSE 'Người bán' END,'active',m.active,
            'sale_count',coalesce(a.sale_count,0),'revenue_dong',coalesce(a.revenue,0),
            'voids',coalesce(a.voids,0),'manual_lines',coalesce(x.manual_lines,0))
        FROM members m LEFT JOIN activity a ON a.member_id=m.id LEFT JOIN manual x ON x.member_id=m.id
        WHERE m.store_id=$1 ORDER BY coalesce(a.revenue,0) DESC,m.id LIMIT 51
    "#).bind(ctx.actor.store_id).bind(from).bind(to).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items(rows, 50, "Hoạt động thành viên");
    out.data["from"] = json!(from);
    out.data["to"] = json!(to);
    out.data["period_days"] = json!((to - from).num_days() + 1);
    Ok(out)
}
async fn anomalies(
    ctx: &ToolContext,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<ToolOutput, ToolError> {
    let rows=sqlx::query_scalar(r#"
        WITH baseline AS (
            SELECT count(*) n,count(*) FILTER (WHERE status='voided') voids FROM sales
            WHERE store_id=$1 AND business_date >= $2::date-60 AND business_date<$2
        ), current AS (
            SELECT count(*) n,count(*) FILTER (WHERE status='voided') voids FROM sales
            WHERE store_id=$1 AND business_date BETWEEN $2 AND $3
        ), hours AS (
            SELECT extract(hour FROM sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh') h,count(*) n FROM sales
            WHERE store_id=$1 AND business_date BETWEEN $4::date-59 AND $4 AND status='completed' GROUP BY h
        ), findings AS (
            SELECT 'void_rate' kind,'store' id,jsonb_build_object('kind','void_rate','void_count',c.voids,
                'sale_count',c.n,'rate',c.voids::float8/c.n,'normal_rate',b.voids::float8/b.n) value
            FROM current c CROSS JOIN baseline b WHERE c.n>0 AND b.n>0 AND c.voids::numeric/c.n>b.voids::numeric/b.n
            UNION ALL SELECT 'negative_stock',p.id::text,jsonb_build_object('kind','negative_stock','product_id',p.id,
                'name',p.name,'quantity',p.stock_quantity,'as_of',$4::date)
            FROM products p WHERE p.store_id=$1 AND NOT p.archived AND p.stock_quantity<0
            UNION ALL SELECT 'price_change',h.id::text,jsonb_build_object('kind','price_change','product_id',h.product_id,'name',p.name,
                'field',h.field,'old_price_dong',h.old_value,'new_price_dong',h.new_value,'changed_at',h.changed_at,
                'change_pct',CASE WHEN h.old_value>0 THEN (h.new_value-h.old_value)::numeric*100/h.old_value END)
            FROM price_history h JOIN products p ON p.id=h.product_id AND p.store_id=h.store_id WHERE h.store_id=$1 AND h.field IN ('price','unit_price')
                AND (h.changed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2 AND $3
                AND h.old_value IS NOT NULL AND ((h.old_value>0 AND abs(h.new_value::numeric-h.old_value)*100>h.old_value::numeric*30)
                    OR (h.old_value=0 AND h.new_value>0))
            UNION ALL SELECT 'unusual_hour',s.id::text,jsonb_build_object('kind','unusual_hour','sale_id',s.id,
                'sale_date',s.business_date,'hour',extract(hour FROM s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh'),
                'sold_time',to_char(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI'),
                'member_display_name',(SELECT m.display_name FROM members m WHERE m.id=s.member_id AND m.store_id=s.store_id),
                'products',coalesce((SELECT jsonb_agg(jsonb_build_object('name',coalesce(p.name,l.manual_label),'quantity',l.quantity))
                    FROM sale_lines l LEFT JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id WHERE l.sale_id=s.id AND l.store_id=s.store_id),'[]'::jsonb))
            FROM sales s LEFT JOIN hours h ON h.h=extract(hour FROM s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 AND s.status='completed'
                AND (SELECT sum(n) FROM hours)>0 AND coalesce(h.n,0)::numeric/(SELECT sum(n) FROM hours)<0.02
        ) SELECT value FROM findings ORDER BY kind,id LIMIT 51
    "#).bind(ctx.actor.store_id).bind(from).bind(to).bind(ctx.today).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items(rows, 50, "Các dấu hiệu cần kiểm tra");
    out.data["from"] = json!(from);
    out.data["to"] = json!(to);
    out.data["lookback_days"] = json!((to - from).num_days());
    out.data["price_change_threshold_pct"] = json!(30);
    out.data["note_vi"] = json!(
        "Tỷ lệ hủy so với 60 ngày trước khoảng yêu cầu; giờ ít gặp chiếm dưới 2% đơn hoàn tất trong 60 ngày tính đến ngày tham chiếu. Tồn kho là số hiện tại, không phải lịch sử."
    );
    Ok(out)
}
async fn thresholds(ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
    let rows=sqlx::query_scalar(r#"
        WITH units AS (
            SELECT l.product_id,sum(l.quantity::bigint*l.quantity_in_base)::float8/28 avg_daily
            FROM sale_lines l JOIN sales s ON s.id=l.sale_id AND s.store_id=l.store_id
            WHERE s.store_id=$1 AND s.status='completed' AND s.business_date BETWEEN $2::date-27 AND $2 GROUP BY l.product_id
        ), restocks AS (
            SELECT DISTINCT l.product_id,(r.confirmed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date d
            FROM receipt_lines l JOIN receipts r ON r.id=l.receipt_id AND r.store_id=l.store_id
            WHERE r.store_id=$1 AND r.status='confirmed' AND (r.confirmed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<=$2
        ), gaps AS (SELECT product_id,d-lag(d) OVER (PARTITION BY product_id ORDER BY d) gap FROM restocks),
        typical AS (SELECT product_id,avg(gap)::float8 gap FROM gaps WHERE gap>0 GROUP BY product_id)
        SELECT jsonb_build_object('product_id',p.id,'name',p.name,'avg_daily_units',coalesce(u.avg_daily,0),
            'restock_gap_days',coalesce(t.gap,7),'suggested_threshold',ceil(coalesce(u.avg_daily,0)*coalesce(t.gap,7))::bigint,
            'current_threshold',coalesce(p.low_stock_threshold,s.low_stock_threshold),
            'product_threshold',p.low_stock_threshold,'uses_store_default',p.low_stock_threshold IS NULL)
        FROM products p JOIN stores s ON s.id=p.store_id LEFT JOIN units u ON u.product_id=p.id LEFT JOIN typical t ON t.product_id=p.id
        WHERE p.store_id=$1 AND NOT p.archived AND p.stock_quantity IS NOT NULL ORDER BY p.low_stock_threshold IS NOT NULL,p.id LIMIT 51
    "#).bind(ctx.actor.store_id).bind(ctx.today).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items(rows, 50, "Ngưỡng tồn kho gợi ý");
    let missing: i64 = sqlx::query_scalar("SELECT count(*) FROM products WHERE store_id=$1 AND NOT archived AND stock_quantity IS NOT NULL AND low_stock_threshold IS NULL")
        .bind(ctx.actor.store_id).fetch_one(pool(&ctx.state)?).await?;
    out.data["missing_threshold_count"] = json!(missing);
    out.data["sales_window_days"] = json!(28);
    Ok(out)
}
async fn setup(ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
    let flags:(bool,bool,bool,bool,bool,i64,i64,i64)=sqlx::query_as(r#"
        SELECT s.bank_account_number IS NOT NULL AND s.bank_bin IS NOT NULL AND s.bank_account_name IS NOT NULL,
            EXISTS(SELECT 1 FROM members m WHERE m.store_id=s.id AND m.active AND m.role='seller') OR
                EXISTS(SELECT 1 FROM invites i WHERE i.store_id=s.id AND i.role='seller' AND (i.used_at IS NOT NULL OR i.expires_at>$2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')),
            s.low_stock_threshold<>5 OR EXISTS(SELECT 1 FROM products p WHERE p.store_id=s.id AND NOT p.archived AND p.low_stock_threshold IS NOT NULL),
            EXISTS(SELECT 1 FROM day_closes c WHERE c.store_id=s.id),
            (SELECT count(*) FROM products p WHERE p.store_id=s.id AND NOT p.archived)>=10,
            (SELECT count(*) FROM members m WHERE m.store_id=s.id AND m.active),
            (SELECT count(*) FROM products p WHERE p.store_id=s.id AND NOT p.archived AND p.stock_quantity IS NOT NULL AND p.low_stock_threshold IS NULL),
            (SELECT count(*) FROM invites i WHERE i.store_id=s.id AND i.used_at IS NULL AND i.expires_at>$2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        FROM stores s WHERE s.id=$1
    "#).bind(ctx.actor.store_id).bind(ctx.today).fetch_optional(pool(&ctx.state)?).await?.ok_or_else(||ToolError::NotFound("store".into()))?;
    let rows = vec![
        json!({"key":"vietqr","done":flags.0,"hint_vi":"Mở Tài khoản → Tài khoản ngân hàng VietQR để cài tài khoản nhận tiền."}),
        json!({"key":"seller","done":flags.1,"hint_vi":"Mở Tài khoản → Mời bằng mã QR để mời người bán."}),
        json!({"key":"can_enroll_reviewed","done":false,"hint_vi":"Chưa xác minh việc kiểm tra quyền thêm sản phẩm của người bán; cần chủ cửa hàng kiểm tra thủ công."}),
        json!({"key":"thresholds","done":flags.2,"hint_vi":"Tùy chỉnh Ngưỡng sắp hết hàng ở Tài khoản hoặc ngưỡng riêng trong chi tiết sản phẩm."}),
        json!({"key":"first_day_close","done":flags.3,"hint_vi":"Mở Báo cáo → Chốt sổ và nhập tiền đếm được."}),
        json!({"key":"ten_products","done":flags.4,"hint_vi":"Thêm ít nhất 10 sản phẩm vào kho bằng camera hoặc màn Thêm sản phẩm."}),
    ];
    let mut out = items(rows, 50, "Danh sách cài đặt cửa hàng");
    out.data["member_count"] = json!(flags.5);
    out.data["threshold_missing_count"] = json!(flags.6);
    out.data["pending_invite_count"] = json!(flags.7);
    Ok(out)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptArgs {
    receipt_id: Uuid,
}
async fn receipt(ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
    let id = parse::<ReceiptArgs>(args)?.receipt_id;
    let mut data:Value=sqlx::query_scalar("SELECT jsonb_build_object('receipt_id',id,'status',status,'total_dong',total,'supplier',supplier,'ocr_text',ocr_text) FROM receipts WHERE store_id=$1 AND id=$2")
        .bind(ctx.actor.store_id).bind(id).fetch_optional(pool(&ctx.state)?).await?.ok_or_else(||ToolError::NotFound("receipt".into()))?;
    let rows:Vec<Value>=sqlx::query_scalar(r#"
        SELECT jsonb_build_object('line_id',l.id,'name',l.product_name,'quantity',l.quantity,'cost_dong',l.cost,
            'product_id',p.id,'product_name',p.name,'confidence',l.match_confidence,'candidates',l.candidates)
        FROM receipt_lines l LEFT JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
        WHERE l.store_id=$1 AND l.receipt_id=$2 ORDER BY l.position,l.id LIMIT 51
    "#).bind(ctx.actor.store_id).bind(id).fetch_all(pool(&ctx.state)?).await?;
    let mut out = items(rows, 50, "Các dòng hóa đơn nhập");
    // Raw OCR can contain forged supplier/system instructions. The assistant only needs
    // parsed lines for review; retain the original OCR in storage for the receipt UI.
    let has_ocr = data
        .as_object_mut()
        .expect("receipt object")
        .remove("ocr_text")
        .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
    data["has_ocr_text"] = json!(has_ocr);
    let lines = out.data["items"].as_array().unwrap();
    data["review_line_count"] = json!(
        lines
            .iter()
            .filter(
                |l| l["product_id"].is_null() || l["confidence"].as_f64().is_some_and(|c| c < 0.8)
            )
            .count()
    );
    data["lines"] = out.data["items"].clone();
    data["truncated"] = json!(out.truncated);
    data["supplier_text"] = Value::Null;
    data["note_vi"] = json!(if data["supplier"].is_null() {
        "Chưa xác định được nhà cung cấp; nội dung hóa đơn cần được kiểm tra."
    } else {
        "Tên nhà cung cấp đã lưu trong trường supplier; nội dung hóa đơn cần được kiểm tra."
    });
    let card_lines: Vec<Value> = data["lines"]
        .as_array()
        .expect("line array")
        .iter()
        .map(|line| {
            let mut line = line.clone();
            line["cost"] = line["cost_dong"].take();
            line.as_object_mut().unwrap().remove("candidates");
            line.as_object_mut()
                .expect("line object")
                .remove("cost_dong");
            line
        })
        .collect();
    out.card = Some(json!({"type":"receipt_lines","receipt_id":id,"lines":card_lines}));
    out.data = data;
    Ok(out)
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportKind {
    Transactions,
    PriceList,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportArgs {
    kind: ExportKind,
    from: String,
    to: String,
}
async fn export(ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
    let args = parse::<ExportArgs>(args)?;
    let from = date(&args.from)?;
    let to = date(&args.to)?;
    if from > to {
        return Err(invalid());
    }
    let revenue: i64 = sqlx::query_scalar("SELECT coalesce(sum(total),0)::bigint FROM sales WHERE store_id=$1 AND business_date BETWEEN $2 AND $3 AND status='completed'")
        .bind(ctx.actor.store_id).bind(from).bind(to).fetch_one(pool(&ctx.state)?).await?;
    let path = match args.kind {
        ExportKind::Transactions => format!("/v1/exports/transactions?from={from}&to={to}"),
        ExportKind::PriceList => "/v1/exports/price-list".into(),
    };
    Ok(ToolOutput::new(
        json!({"path":path,"from":from,"to":to,"revenue_dong":revenue,"instruction_vi":"Mở đường dẫn này trong ứng dụng để tải tệp bằng phiên đăng nhập của bạn."}),
        "Đã lấy đường dẫn tải báo cáo.",
    ))
}
