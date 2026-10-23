use chrono::{DateTime, NaiveDate, Utc};
pub const STORE_TZ: chrono_tz::Tz = chrono_tz::Asia::Ho_Chi_Minh;
pub fn business_date(at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&STORE_TZ).date_naive()
}
#[cfg(test)]
mod tests {
    use super::*;
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
