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
    fn pinned_business_clock_controls_day_close() {
        for (pinned, expected) in [
            ("2026-01-15T10:00:00+07:00", false),
            ("2026-01-15T21:00:00+07:00", true),
        ] {
            let clock = crate::time::Clock::from_lookup(|name| {
                (name == "TAPHOA_TEST_NOW").then(|| pinned.into())
            })
            .unwrap();
            let now = clock
                .now()
                .with_timezone(&crate::time::STORE_TZ)
                .naive_local();
            assert_eq!(due(now, false), expected);
            assert!(!due(now, true));
            assert_eq!(clock.today(), now.date());
            assert_eq!(now.format("%H").to_string(), &pinned[11..13]);
        }
    }

    #[test]
    fn local_time_boundary() {
        let at = |s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
        assert!(!due(at("2026-10-26 19:59:00"), false));
        assert!(due(at("2026-10-26 20:00:00"), false));
        assert!(!due(at("2026-10-26 20:00:00"), true));
    }
}
