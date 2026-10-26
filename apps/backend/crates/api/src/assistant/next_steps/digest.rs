use super::*;

pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        let unread:bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assistant_digests d WHERE d.store_id=$1 AND d.business_date=$2 AND NOT EXISTS(SELECT 1 FROM assistant_digest_reads r WHERE r.store_id=d.store_id AND r.business_date=d.business_date AND r.member_id=$3))")
            .bind(actor.store_id).bind(input.today).bind(actor.member_id).fetch_one(db).await?;
        Ok(if unread {
            let mut step =
                NextStep::new("digest", "Tóm tắt sáng nay", 5, None, navigate("/digest"));
            step.id = format!("digest:{}", input.today);
            vec![step]
        } else {
            vec![]
        })
    })
}
