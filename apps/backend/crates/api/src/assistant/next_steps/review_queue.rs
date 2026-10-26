use super::*;
use crate::auth::{self, Action};

pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        if !auth::can(actor, Action::ReviewQueue) {
            return Ok(vec![]);
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sale_lines l JOIN sales s ON s.id=l.sale_id AND s.store_id=l.store_id WHERE l.store_id=$1 AND l.source='manual' AND l.review_status='open' AND s.status='completed'")
            .bind(actor.store_id).fetch_optional(db).await?.unwrap_or(0);
        Ok(if count > 0 {
            vec![
                NextStep::new(
                    "review_queue",
                    "Xử lý hàng ngoài danh mục",
                    30,
                    Some(Action::ReviewQueue),
                    chat(input, "review_queue", "Giúp tôi xử lý hàng ngoài danh mục"),
                )
                .counted(count, "dòng chờ xử lý"),
            ]
        } else {
            vec![]
        })
    })
}
