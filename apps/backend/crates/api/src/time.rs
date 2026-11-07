use std::time::Instant;

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};

/// Business clock; transport/authentication and database audit timestamps keep real time.
#[derive(Clone, Copy, Debug, Default)]
pub struct Clock {
    pinned: Option<(DateTime<Utc>, Instant)>,
}

impl Clock {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        Self::from_lookup_at(get, Utc::now())
    }

    fn from_lookup_at(
        get: impl Fn(&str) -> Option<String>,
        wall_now: DateTime<Utc>,
    ) -> anyhow::Result<Self> {
        let Some(raw) = get("TAPHOA_TEST_NOW") else {
            return Ok(Self::default());
        };
        anyhow::ensure!(
            !get("RAILWAY_ENVIRONMENT_NAME")
                .is_some_and(|env| env.trim().eq_ignore_ascii_case("production")),
            "TAPHOA_TEST_NOW is forbidden in production"
        );
        let invalid = || {
            anyhow::anyhow!(
                "TAPHOA_TEST_NOW must be HH:MM in Asia/Ho_Chi_Minh or an RFC 3339 timestamp with offset"
            )
        };
        let pinned = if raw.len() == 5
            && raw.as_bytes()[2] == b':'
            && raw
                .bytes()
                .enumerate()
                .all(|(i, byte)| i == 2 || byte.is_ascii_digit())
        {
            let time = NaiveTime::parse_from_str(&raw, "%H:%M").map_err(|_| invalid())?;
            STORE_TZ
                .from_local_datetime(&business_date(wall_now).and_time(time))
                .single()
                .ok_or_else(invalid)?
                .with_timezone(&Utc)
        } else {
            DateTime::parse_from_rfc3339(&raw)
                .map_err(|_| invalid())?
                .with_timezone(&Utc)
        };
        Ok(Self {
            pinned: Some((pinned, Instant::now())),
        })
    }

    pub fn now(self) -> DateTime<Utc> {
        self.pinned
            .map_or_else(Utc::now, |(pinned, started)| pinned + started.elapsed())
    }

    pub fn today(self) -> NaiveDate {
        business_date(self.now())
    }
}

/// How far a client `sold_at` may differ from server time. Offline queues deliver old sales,
/// so the past bound is generous; a small future skew covers phone clocks that run fast.
#[derive(Clone, Copy, Debug)]
pub struct SaleWindow {
    pub max_age: chrono::Duration,
    pub max_future: chrono::Duration,
}
impl Default for SaleWindow {
    fn default() -> Self {
        Self {
            max_age: chrono::Duration::hours(72),
            max_future: chrono::Duration::minutes(5),
        }
    }
}
impl SaleWindow {
    /// True when `at` lies inside `[now - max_age, now + max_future]`.
    pub fn contains(self, at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
        at >= now - self.max_age && at <= now + self.max_future
    }
}

/// Oldest business date the books accept (before the app shipped): day close and a Lead's
/// backdated debt entries.
pub const EARLIEST_BUSINESS_DATE: NaiveDate = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();

pub const STORE_TZ: chrono_tz::Tz = chrono_tz::Asia::Ho_Chi_Minh;
pub fn business_date(at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&STORE_TZ).date_naive()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn override_sets_starting_instant_and_business_date() {
        let clock = Clock::from_lookup(|name| {
            (name == "TAPHOA_TEST_NOW").then(|| "2026-01-15T00:30:00+07:00".into())
        })
        .unwrap();
        let now = clock.now();
        assert_eq!(now.date_naive().to_string(), "2026-01-14");
        assert_eq!(now.format("%H:%M").to_string(), "17:30");
        assert_eq!(clock.today().to_string(), "2026-01-15");
    }

    #[test]
    fn time_only_uses_store_date_at_startup() {
        for (wall_now, date) in [
            ("2026-10-23T16:59:59Z", "2026-10-23"),
            ("2026-10-23T17:00:00Z", "2026-10-24"),
            ("2026-12-31T17:00:00Z", "2027-01-01"),
        ] {
            for time in ["00:00", "10:00", "23:59"] {
                let clock = Clock::from_lookup_at(
                    |name| (name == "TAPHOA_TEST_NOW").then(|| time.into()),
                    wall_now.parse().unwrap(),
                )
                .unwrap();
                assert_eq!(clock.today().to_string(), date);
                assert_eq!(
                    clock
                        .now()
                        .with_timezone(&STORE_TZ)
                        .format("%H:%M")
                        .to_string(),
                    time
                );
            }
        }
    }

    #[test]
    fn override_advances_across_business_midnight_and_copies_share_start() {
        let pinned: DateTime<Utc> = "2026-01-15T23:59:59+07:00".parse().unwrap();
        let started = Instant::now() - std::time::Duration::from_secs(2);
        let clock = Clock {
            pinned: Some((pinned, started)),
        };
        let copied = clock;
        let before = started.elapsed();
        let now = copied.now();
        let after = started.elapsed();
        assert!(now >= pinned + before && now <= pinned + after);
        assert!(clock.now() >= now);
        assert_eq!(clock.today().to_string(), "2026-01-16");
    }

    #[test]
    fn no_override_uses_wall_clock() {
        let before = Utc::now();
        let clock = Clock::from_lookup(|_| None).unwrap();
        let now = clock.now();
        assert!(now >= before && now <= Utc::now());
    }

    #[test]
    fn rejects_invalid_override_and_production() {
        for raw in [
            "",
            "invalid",
            "2026-01-15T10:00:00",
            "24:00",
            "10:60",
            "9:00",
            " 9:00",
            "10:00:00",
        ] {
            let error = Clock::from_lookup(|name| (name == "TAPHOA_TEST_NOW").then(|| raw.into()))
                .unwrap_err();
            assert!(error.to_string().contains("must be HH:MM"));
        }
        for env in ["production", "PRODUCTION", " production "] {
            let error = Clock::from_lookup(|name| match name {
                "TAPHOA_TEST_NOW" => Some("2026-01-15T10:00:00+07:00".into()),
                "RAILWAY_ENVIRONMENT_NAME" => Some(env.into()),
                _ => None,
            })
            .unwrap_err();
            assert!(error.to_string().contains("forbidden in production"));
        }
        assert!(
            Clock::from_lookup(|name| {
                (name == "RAILWAY_ENVIRONMENT_NAME").then(|| "production".into())
            })
            .is_ok()
        );
    }

    #[test]
    fn local_midnight_boundary() {
        for (at, date) in [
            ("2026-10-23T16:59:59Z", "2026-10-23"),
            ("2026-10-23T17:00:00Z", "2026-10-24"),
            ("2026-12-31T17:00:00Z", "2027-01-01"),
        ] {
            assert_eq!(business_date(at.parse().unwrap()).to_string(), date);
        }
    }
}
