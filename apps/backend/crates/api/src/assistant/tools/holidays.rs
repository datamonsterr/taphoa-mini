//! Owner-editable demand heuristics, not measured holiday effects.
use chrono::{Datelike, NaiveDate};

struct Holiday {
    name: &'static str,
    year: Option<i32>,
    month: u32,
    day: u32,
    from: i64,
    to: i64,
    factor: f64,
}
const HOLIDAYS: &[Holiday] = &[
    Holiday {
        name: "Tết Nguyên Đán",
        year: Some(2026),
        month: 2,
        day: 17,
        from: -10,
        to: -1,
        factor: 2.0,
    },
    Holiday {
        name: "Tết Nguyên Đán",
        year: Some(2026),
        month: 2,
        day: 17,
        from: 0,
        to: 2,
        factor: 0.5,
    },
    Holiday {
        name: "Tết Nguyên Đán",
        year: Some(2027),
        month: 2,
        day: 6,
        from: -10,
        to: -1,
        factor: 2.0,
    },
    Holiday {
        name: "Tết Nguyên Đán",
        year: Some(2027),
        month: 2,
        day: 6,
        from: 0,
        to: 2,
        factor: 0.5,
    },
    Holiday {
        name: "Tết Nguyên Đán",
        year: Some(2028),
        month: 1,
        day: 26,
        from: -10,
        to: -1,
        factor: 2.0,
    },
    Holiday {
        name: "Tết Nguyên Đán",
        year: Some(2028),
        month: 1,
        day: 26,
        from: 0,
        to: 2,
        factor: 0.5,
    },
    Holiday {
        name: "Tết Dương lịch",
        year: None,
        month: 1,
        day: 1,
        from: -2,
        to: -1,
        factor: 1.3,
    },
    Holiday {
        name: "30/4 và 1/5",
        year: None,
        month: 5,
        day: 1,
        from: -3,
        to: 0,
        factor: 1.3,
    },
    Holiday {
        name: "Quốc khánh 2/9",
        year: None,
        month: 9,
        day: 2,
        from: -2,
        to: 0,
        factor: 1.3,
    },
    Holiday {
        name: "Giỗ Tổ Hùng Vương",
        year: Some(2026),
        month: 4,
        day: 26,
        from: -1,
        to: -1,
        factor: 1.2,
    },
    Holiday {
        name: "Giỗ Tổ Hùng Vương",
        year: Some(2027),
        month: 4,
        day: 16,
        from: -1,
        to: -1,
        factor: 1.2,
    },
    Holiday {
        name: "Trung thu",
        year: Some(2026),
        month: 9,
        day: 25,
        from: -3,
        to: -1,
        factor: 1.3,
    },
    Holiday {
        name: "Trung thu",
        year: Some(2027),
        month: 9,
        day: 15,
        from: -3,
        to: -1,
        factor: 1.3,
    },
];
pub(super) fn uplift(date: NaiveDate) -> (f64, Option<&'static str>) {
    for holiday in HOLIDAYS {
        // The next year's Jan 1 also covers Dec 30-31 of this year.
        for year in [date.year(), date.year() + 1] {
            if holiday.year.is_some_and(|fixed| fixed != year) {
                continue;
            }
            let Some(day) = NaiveDate::from_ymd_opt(year, holiday.month, holiday.day) else {
                continue;
            };
            if (holiday.from..=holiday.to).contains(&(date - day).num_days()) {
                return (holiday.factor, Some(holiday.name));
            }
        }
    }
    (1.0, None)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_window_includes_its_bounds_and_no_extra_days() {
        for holiday in HOLIDAYS {
            let day =
                NaiveDate::from_ymd_opt(holiday.year.unwrap_or(2026), holiday.month, holiday.day)
                    .unwrap();
            for offset in holiday.from..=holiday.to {
                assert_eq!(
                    uplift(day + chrono::Duration::days(offset)),
                    (holiday.factor, Some(holiday.name))
                );
            }
        }
        for day in [
            "2026-02-06",
            "2026-02-20",
            "2026-12-29",
            "2027-01-01",
            "2026-04-27",
            "2026-05-02",
            "2026-09-03",
            "2026-09-25",
            "2027-04-16",
        ] {
            assert_eq!(uplift(day.parse().unwrap()), (1.0, None), "{day}");
        }
        assert_eq!(
            uplift("2026-12-31".parse().unwrap()),
            (1.3, Some("Tết Dương lịch"))
        );
    }
}
