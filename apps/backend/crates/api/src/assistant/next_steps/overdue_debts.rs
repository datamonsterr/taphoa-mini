use super::*;
use crate::auth::{self, Action};

/// Customers owing for more than 7 days: one indexed query on `(store_id, oldest_debt_date)`.
pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        if !auth::can(actor, Action::RecordDebt) {
            return Ok(vec![]);
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM customers WHERE store_id=$1 AND balance>0 AND archived_at IS NULL AND oldest_debt_date < $2::date - 7",
        )
        .bind(actor.store_id)
        .bind(input.today)
        .fetch_one(db)
        .await?;
        Ok(if count > 0 {
            vec![
                NextStep::new(
                    "overdue_debts",
                    "Nhắc khách nợ quá hạn",
                    35,
                    Some(Action::RecordDebt),
                    navigate("/debts"),
                )
                .counted(count, "khách nợ quá 7 ngày"),
            ]
        } else {
            vec![]
        })
    })
}
