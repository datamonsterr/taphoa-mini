use super::*;
use crate::auth::{self, Action};

pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        if !auth::can(actor, Action::ChangePrice) {
            return Ok(vec![]);
        }
        let count: i64 = sqlx::query_scalar("SELECT count(DISTINCT p.id) FROM receipts r JOIN receipt_lines l ON l.receipt_id=r.id AND l.store_id=r.store_id JOIN products p ON p.id=l.product_id AND p.store_id=r.store_id WHERE r.store_id=$1 AND r.status='confirmed' AND r.confirmed_at >= $2::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' - interval '7 days' AND r.confirmed_at <= $2::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AND NOT p.archived AND ceil(l.cost::numeric / l.quantity) > p.price::numeric * 0.95")
            .bind(actor.store_id).bind(input.now_local).fetch_optional(db).await?.unwrap_or(0);
        Ok(if count > 0 {
            vec![
                NextStep::new(
                    "margin_alert",
                    "Kiểm tra lợi nhuận",
                    25,
                    Some(Action::ChangePrice),
                    chat(
                        input,
                        "margin_alert",
                        "Kiểm tra lợi nhuận các sản phẩm vừa nhập",
                    ),
                )
                .counted(count, "sản phẩm có giá vốn cao"),
            ]
        } else {
            vec![]
        })
    })
}
