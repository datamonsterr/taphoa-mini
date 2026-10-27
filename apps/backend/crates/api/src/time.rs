use chrono::{DateTime, NaiveDate, Utc};

/// Business clock; transport/authentication and database audit timestamps keep real time.
#[derive(Clone, Copy, Debug, Default)]
pub struct Clock {
    pinned: Option<DateTime<Utc>>,
}

impl Clock {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let Some(raw) = get("TAPHOA_TEST_NOW") else {
            return Ok(Self::default());
        };
        anyhow::ensure!(
            !get("RAILWAY_ENVIRONMENT_NAME")
                .is_some_and(|env| env.trim().eq_ignore_ascii_case("production")),
            "TAPHOA_TEST_NOW is forbidden in production"
        );
        let pinned = DateTime::parse_from_rfc3339(&raw)
            .map_err(|_| {
                anyhow::anyhow!("TAPHOA_TEST_NOW must be an RFC 3339 timestamp with offset")
            })?
            .with_timezone(&Utc);
        Ok(Self {
            pinned: Some(pinned),
        })
    }

    pub fn now(self) -> DateTime<Utc> {
        self.pinned.unwrap_or_else(Utc::now)
    }

    pub fn today(self) -> NaiveDate {
        business_date(self.now())
    }
}

pub const STORE_TZ: chrono_tz::Tz = chrono_tz::Asia::Ho_Chi_Minh;
pub fn business_date(at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&STORE_TZ).date_naive()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn override_pins_instant_and_business_date() {
        let clock = Clock::from_lookup(|name| {
            (name == "TAPHOA_TEST_NOW").then(|| "2026-01-15T00:30:00+07:00".into())
        })
        .unwrap();
        assert_eq!(clock.now().to_rfc3339(), "2026-01-14T17:30:00+00:00");
        assert_eq!(clock.now(), clock.now());
        assert_eq!(clock.today().to_string(), "2026-01-15");
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
        for raw in ["", "invalid", "2026-01-15T10:00:00"] {
            assert!(Clock::from_lookup(|_| Some(raw.into())).is_err());
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
