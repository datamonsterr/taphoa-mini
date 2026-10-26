use super::*;
use crate::auth::{self, Action};

pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, _input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        if !auth::can(actor, Action::EnrollProduct) {
            return Ok(vec![]);
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM receipts WHERE store_id=$1 AND status='draft'",
        )
        .bind(actor.store_id)
        .fetch_optional(db)
        .await?
        .unwrap_or(0);
        Ok(if count > 0 {
            vec![
                NextStep::new(
                    "draft_receipts",
                    "Hoàn tất hóa đơn nhập",
                    20,
                    Some(Action::EnrollProduct),
                    navigate("/receipts"),
                )
                .counted(count, "hóa đơn nháp"),
            ]
        } else {
            vec![]
        })
    })
}
