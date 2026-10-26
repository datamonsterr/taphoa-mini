use super::*;
use crate::auth::{self, Action};

pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        if !auth::can(actor, Action::ManageStore) {
            return Ok(vec![]);
        }
        let count: i64 = sqlx::query_scalar("SELECT (CASE WHEN bank_account_number IS NULL THEN 1 ELSE 0 END + CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE store_id=$1 AND active AND id<>$3) THEN 1 ELSE 0 END + CASE WHEN NOT EXISTS(SELECT 1 FROM day_closes WHERE store_id=$1) THEN 1 ELSE 0 END)::bigint FROM stores WHERE id=$1 AND created_at >= $2::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' - interval '14 days' AND created_at <= $2::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'")
            .bind(actor.store_id).bind(input.now_local).bind(actor.member_id).fetch_optional(db).await?.unwrap_or(0);
        Ok(if count > 0 {
            vec![
                NextStep::new(
                    "setup",
                    "Cài đặt cửa hàng",
                    40,
                    Some(Action::ManageStore),
                    chat(input, "setup", "Hướng dẫn tôi cài đặt cửa hàng"),
                )
                .counted(count, "mục cài đặt chưa xong"),
            ]
        } else {
            vec![]
        })
    })
}
