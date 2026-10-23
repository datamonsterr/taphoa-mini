//! Pure money rules for sales, purchases, margin alerts and day close (docs/data-model.md 3.5-3.7).
//! All amounts are whole VND in `i64`. No I/O here so the rules are unit-testable.
use crate::auth::Actor;
use chrono::NaiveDate;
use uuid::Uuid;

/// Sum of `quantity * unit_price`; `None` on overflow.
pub fn sum_lines(lines: &[(i32, i64)]) -> Option<i64> {
    lines.iter().try_fold(0_i64, |total, &(quantity, price)| {
        total.checked_add(i64::from(quantity).checked_mul(price)?)
    })
}
/// `received - total` when `received >= total`, else `None`.
pub fn change_given(total: i64, received: i64) -> Option<i64> {
    if received >= total {
        received.checked_sub(total)
    } else {
        None
    }
}
/// Ceil of `unit_cost / quantity_in_base` (quantity_in_base >= 1).
pub fn base_unit_cost(unit_cost: i64, quantity_in_base: i32) -> i64 {
    assert!(quantity_in_base >= 1, "quantity_in_base must be positive");
    let quantity = i64::from(quantity_in_base);
    unit_cost.div_euclid(quantity) + i64::from(unit_cost.rem_euclid(quantity) != 0)
}
/// Margin percent of the selling price, rounded to 2 decimals; `None` when price is 0.
pub fn margin_pct(price: i64, cost: i64) -> Option<f64> {
    if price == 0 {
        return None;
    }
    let mut numerator = (i128::from(price) - i128::from(cost)) * 10_000;
    let denominator = i128::from(price).abs();
    if price < 0 {
        numerator = -numerator;
    }
    let half = denominator / 2;
    let rounded_bp = (numerator + if numerator >= 0 { half } else { -half }) / denominator;
    Some(rounded_bp as f64 / 100.0)
}
/// True when margin is strictly below the threshold (`threshold_bp` = percent*100, e.g. 12.5% = 1250).
/// A price of 0 counts as below threshold when cost > 0.
pub fn margin_below_threshold(price: i64, cost: i64, threshold_bp: i64) -> bool {
    if price == 0 {
        return cost > 0;
    }
    let margin = (i128::from(price) - i128::from(cost)) * 10_000;
    let threshold = i128::from(price) * i128::from(threshold_bp);
    if price > 0 {
        margin < threshold
    } else {
        margin > threshold
    }
}
/// Smallest price >= cost*(1+max(threshold,10%)), rounded up to the next 1000.
pub fn suggested_price(cost: i64, threshold_bp: i64) -> i64 {
    let numerator = i128::from(cost) * (10_000 + i128::from(threshold_bp.max(1000)));
    let step = 10_000 * 1000;
    let rounded = numerator.div_euclid(step) + i128::from(numerator.rem_euclid(step) != 0);
    i64::try_from(rounded * 1000).expect("suggested price exceeds i64 range")
}
pub fn expected_cash(
    opening_float: i64,
    cash_sales: i64,
    cash_refunds: i64,
    cash_expenses: i64,
) -> i64 {
    let cash = i128::from(opening_float) + i128::from(cash_sales)
        - i128::from(cash_refunds)
        - i128::from(cash_expenses);
    i64::try_from(cash).expect("expected cash exceeds i64 range")
}
/// Lead may void any sale; a seller only their own sale on the same business date.
pub fn can_void(
    actor: &Actor,
    sale_member: Uuid,
    sale_business_date: NaiveDate,
    today: NaiveDate,
) -> bool {
    match actor.role {
        crate::auth::Role::Lead => true,
        crate::auth::Role::Seller => actor.member_id == sale_member && sale_business_date == today,
    }
}
/// Short code: first 6 Crockford base32 chars derived from the sale id (UUIDv7 random tail), uppercase.
pub fn sale_code(id: Uuid) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let tail = id.as_u128() & ((1 << 30) - 1);
    (0..6)
        .rev()
        .map(|position| char::from(ALPHABET[((tail >> (position * 5)) & 31) as usize]))
        .collect()
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
            (9090, 1000, 10000),
            (9091, 1000, 11000),
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
