//! Pure money rules for sales, purchases, margin alerts and day close (docs/data-model.md 3.5-3.7).
//! All amounts are whole VND in `i64`. No I/O here so the rules are unit-testable.
use crate::auth::Actor;
use chrono::NaiveDate;
use uuid::Uuid;

/// Sum of `quantity * unit_price`; `None` on overflow.
pub fn sum_lines(lines: &[(i32, i64)]) -> Option<i64> {
    let _ = lines;
    todo!("E4: checked sum of quantity * unit_price")
}
/// `received - total` when `received >= total`, else `None`.
pub fn change_given(total: i64, received: i64) -> Option<i64> {
    let _ = (total, received);
    todo!("E4")
}
/// Ceil of `unit_cost / quantity_in_base` (quantity_in_base >= 1).
pub fn base_unit_cost(unit_cost: i64, quantity_in_base: i32) -> i64 {
    let _ = (unit_cost, quantity_in_base);
    todo!("E4")
}
/// Margin percent of the selling price, rounded to 2 decimals; `None` when price is 0.
pub fn margin_pct(price: i64, cost: i64) -> Option<f64> {
    let _ = (price, cost);
    todo!("E4: (price-cost)*100/price")
}
/// True when margin is strictly below the threshold (`threshold_bp` = percent*100, e.g. 12.5% = 1250).
/// A price of 0 counts as below threshold when cost > 0.
pub fn margin_below_threshold(price: i64, cost: i64, threshold_bp: i64) -> bool {
    let _ = (price, cost, threshold_bp);
    todo!("E4")
}
/// Smallest price >= cost*(1+max(threshold,10%)), rounded up to the next 1000.
pub fn suggested_price(cost: i64, threshold_bp: i64) -> i64 {
    let _ = (cost, threshold_bp);
    todo!("E4: cost 8500 -> 10000")
}
pub fn expected_cash(
    opening_float: i64,
    cash_sales: i64,
    cash_refunds: i64,
    cash_expenses: i64,
) -> i64 {
    let _ = (opening_float, cash_sales, cash_refunds, cash_expenses);
    todo!("E4: open + sales - refunds - expenses")
}
/// Lead may void any sale; a seller only their own sale on the same business date.
pub fn can_void(
    actor: &Actor,
    sale_member: Uuid,
    sale_business_date: NaiveDate,
    today: NaiveDate,
) -> bool {
    let _ = (actor, sale_member, sale_business_date, today);
    todo!("E4")
}
/// Short code: first 6 Crockford base32 chars derived from the sale id (UUIDv7 random tail), uppercase.
pub fn sale_code(id: Uuid) -> String {
    let _ = id;
    todo!("E4: 6 chars from alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Role;
    fn actor(role: Role, member: Uuid) -> Actor {
        Actor {
            member_id: member,
            store_id: Uuid::nil(),
            session_id: Uuid::nil(),
            role,
            can_enroll: false,
        }
    }
    #[test]
    fn totals_and_change() {
        assert_eq!(sum_lines(&[(2, 9000), (3, 5000)]), Some(33000));
        assert_eq!(sum_lines(&[(1, i64::MAX), (2, i64::MAX)]), None);
        assert_eq!(change_given(33000, 50000), Some(17000));
        assert_eq!(change_given(33000, 33000), Some(0));
        assert_eq!(change_given(33000, 32999), None);
    }
    #[test]
    fn unit_cost_rounds_up() {
        assert_eq!(base_unit_cost(204_000, 24), 8_500);
        assert_eq!(base_unit_cost(100, 3), 34);
        assert_eq!(base_unit_cost(100, 1), 100);
    }
    #[test]
    fn margin_and_threshold() {
        assert_eq!(margin_pct(9000, 8500), Some(5.56));
        assert_eq!(margin_pct(0, 10), None);
        assert!(margin_below_threshold(9000, 8500, 1000));
        assert!(!margin_below_threshold(10000, 8500, 1000));
        assert!(!margin_below_threshold(9000, 8500, 500)); // 5.56 >= 5.00
        assert!(margin_below_threshold(8000, 8500, 0)); // negative margin
        assert!(!margin_below_threshold(8500, 8500, 0)); // 0% is not below 0%
        assert!(margin_below_threshold(0, 1, 0));
    }
    #[test]
    fn suggested_price_table() {
        for (cost, bp, want) in [
            (8500, 900, 10000), // 10% floor beats 9%
            (8500, 2000, 11000),
            (10000, 0, 11000), // exactly cost*1.1 stays 11000
            (9091, 1000, 10000),
            (9092, 1000, 11000),
            (0, 1000, 0),
        ] {
            assert_eq!(suggested_price(cost, bp), want, "cost {cost} bp {bp}");
        }
    }
    #[test]
    fn cash_formula() {
        assert_eq!(
            expected_cash(200_000, 1_500_000, 60_000, 400_000),
            1_240_000
        );
        assert_eq!(expected_cash(0, 0, 0, 50_000), -50_000);
    }
    #[test]
    fn void_authz_table() {
        let me = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let d = |s: &str| s.parse::<NaiveDate>().unwrap();
        let today = d("2026-10-23");
        assert!(can_void(
            &actor(Role::Lead, me),
            other,
            d("2026-01-01"),
            today
        ));
        assert!(can_void(&actor(Role::Seller, me), me, today, today));
        assert!(!can_void(
            &actor(Role::Seller, me),
            me,
            d("2026-10-22"),
            today
        ));
        assert!(!can_void(&actor(Role::Seller, me), other, today, today));
    }
    #[test]
    fn code_is_stable_crockford() {
        let id = Uuid::parse_str("0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b").unwrap();
        let code = sale_code(id);
        assert_eq!(code, sale_code(id));
        assert_eq!(code.len(), 6);
        assert!(
            code.chars()
                .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c))
        );
        assert_ne!(
            code,
            sale_code(Uuid::from_u128(0x0192b1f07c1e7a8a9a512a4f0e7d1c3c))
        );
    }
}
