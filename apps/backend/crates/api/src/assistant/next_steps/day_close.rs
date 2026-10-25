use super::*;

pub fn due(now_local: NaiveDateTime, closed: bool) -> bool {
    now_local.time() >= chrono::NaiveTime::from_hms_opt(20, 0, 0).unwrap() && !closed
}
pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        if !auth::can(actor, Action::DayClose) || !due(input.now_local, false) {
            return Ok(vec![]);
        }
        let closed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM day_closes WHERE store_id=$1 AND business_date=$2)",
        )
        .bind(actor.store_id)
        .bind(input.today)
        .fetch_one(db)
        .await?;
        Ok(if due(input.now_local, closed) {
            let mut step = NextStep::new(
                "day_close",
                "Chốt sổ hôm nay",
                15,
                Some(Action::DayClose),
                navigate("/close"),
            );
            step.id = format!("day_close:{}", input.today);
            vec![step]
        } else {
            vec![]
        })
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_time_boundary() {
        let at = |s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
        assert!(!due(at("2026-10-26 19:59:00"), false));
        assert!(due(at("2026-10-26 20:00:00"), false));
        assert!(!due(at("2026-10-26 20:00:00"), true));
    }
}
