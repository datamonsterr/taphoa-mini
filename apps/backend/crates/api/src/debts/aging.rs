use chrono::{DateTime, NaiveDate, Utc};
use uuid::Uuid;

pub(super) struct Entry {
    pub id: Uuid,
    pub kind: String,
    pub amount: i64,
    pub sale_id: Option<Uuid>,
    pub business_date: NaiveDate,
    pub created_at: DateTime<Utc>,
}
pub(super) fn oldest_debt_date(_entries: &[Entry]) -> Option<NaiveDate> {
    todo!("FIFO aging")
}
pub(super) fn debt_age_days(_oldest: Option<NaiveDate>, _today: NaiveDate) -> Option<i64> {
    todo!("read-time age")
}
pub(super) fn overdue(_oldest: Option<NaiveDate>, _today: NaiveDate) -> bool {
    todo!("read-time overdue")
}
#[cfg(test)]
mod tests {
    use super::*;
    fn date(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 1, day).unwrap()
    }
    fn entry(day: u32, amount: i64) -> Entry {
        Entry {
            id: Uuid::now_v7(),
            kind: "adjustment".into(),
            amount,
            sale_id: None,
            business_date: date(day),
            created_at: date(day).and_hms_opt(0, 0, 0).unwrap().and_utc(),
        }
    }
    #[test]
    fn partial_exact_and_overpayment() {
        let mut rows = vec![entry(1, 100), entry(2, 200), entry(3, -50)];
        assert_eq!(oldest_debt_date(&rows), Some(date(1)));
        rows.push(entry(4, -50));
        assert_eq!(oldest_debt_date(&rows), Some(date(2)));
        rows.push(entry(5, -200));
        assert_eq!(oldest_debt_date(&rows), None);
        rows.push(entry(6, -1));
        assert_eq!(oldest_debt_date(&rows), None);
        assert_eq!(oldest_debt_date(&[]), None);
    }
    #[test]
    fn void_cancels_its_sale_before_fifo() {
        let sale = Uuid::now_v7();
        let mut credit = entry(1, 100);
        credit.kind = "credit_sale".into();
        credit.sale_id = Some(sale);
        let mut void = entry(5, -100);
        void.kind = "void".into();
        void.sale_id = Some(sale);
        let rows = vec![credit, entry(2, 200), entry(3, -50), void];
        assert_eq!(oldest_debt_date(&rows), Some(date(2)));
    }
    #[test]
    fn signed_adjustments_settle_oldest_credit() {
        let rows = vec![entry(2, 50), entry(1, 100), entry(3, -125)];
        assert_eq!(oldest_debt_date(&rows), Some(date(2)));
    }
    #[test]
    fn ties_use_created_at_then_id() {
        let mut a = entry(1, 100);
        let mut b = entry(1, 100);
        a.id = Uuid::from_u128(2);
        b.id = Uuid::from_u128(1);
        // Equal-date tie ordering cannot change the returned date, but input order must not matter.
        let mut rows = vec![a, b, entry(2, 100), entry(3, -200)];
        assert_eq!(oldest_debt_date(&rows), Some(date(2)));
        rows.swap(0, 1);
        assert_eq!(oldest_debt_date(&rows), Some(date(2)));
    }
    #[test]
    fn overdue_boundary_null_and_future_dates() {
        assert_eq!(debt_age_days(Some(date(1)), date(8)), Some(7));
        assert!(!overdue(Some(date(1)), date(8)));
        assert!(overdue(Some(date(1)), date(9)));
        assert_eq!(debt_age_days(None, date(9)), None);
        assert!(!overdue(None, date(9)));
        assert_eq!(debt_age_days(Some(date(9)), date(8)), Some(0));
    }
}
