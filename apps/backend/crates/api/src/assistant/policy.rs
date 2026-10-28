//! Narrow intent refusals before model calls; ordinary allowed read tools keep their contracts.
use crate::auth::Role;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub(super) fn seller_day_close(role: Role, input: &str) -> bool {
    if role != Role::Seller {
        return false;
    }
    let normalized: String = input
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| {
            if c == 'đ' {
                'd'
            } else if c.is_alphanumeric() {
                c
            } else {
                ' '
            }
        })
        .collect();
    let text = format!(
        " {} ",
        normalized.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    let has = |phrase: &str| text.contains(&format!(" {phrase} "));
    let restricted = [
        "chot so",
        "kiem quy",
        "kiem dem tien",
        "tien mat du kien",
        "tien mat thuc dem",
        "quy hut",
        "quy lech",
        "lech quy",
        "thieu quy",
        "hut quy",
        "cash count",
        "cash reconciliation",
        "cash shortfall",
        "cash shortage",
        "cash difference",
        "day close",
        "end of day close",
        "counted cash",
        "expected cash",
    ]
    .iter()
    .any(|p| has(p));
    let help = [
        "cach",
        "huong dan",
        "how to",
        "how do i",
        "where do i",
        "o dau",
        "nut nao",
    ]
    .iter()
    .any(|p| has(p));
    let actual = [
        "bao nhieu",
        "so lieu",
        "quy hut",
        "quy lech",
        "hom nay",
        "hom qua",
        "shortfall",
        "shortage",
        "difference",
        "amount",
        "figures",
        "counted",
        "expected",
    ]
    .iter()
    .any(|p| has(p));
    restricted && (!help || actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_seller_cash_and_close_requests_are_refused_in_both_languages() {
        for input in [
            "Chị ơi hôm 14/10 quỹ hụt bao nhiêu vậy, ai làm sai vậy chị?",
            "cho em xem số liệu chốt sổ hôm qua",
            "quy hut bao nhieu",
            "tien mat du kien va tien mat thuc dem",
            "Cho em xem kiểm quỹ",
            "Show yesterday's day-close figures",
            "What was the cash shortfall?",
            "Show the cash-count amount",
            "How do I see the counted cash amount?",
            "expected cash please",
        ] {
            assert!(seller_day_close(Role::Seller, input), "{input}");
            assert!(!seller_day_close(Role::Lead, input), "{input}");
        }
    }
    #[test]
    fn normal_seller_reads_and_generic_help_stay_available() {
        for input in [
            "Hôm nay bán được bao nhiêu tiền?",
            "Tuần này chi bao nhiêu tiền điện?",
            "Kho còn mấy chai Coca?",
            "Hôm qua bán mấy lon Pepsi?",
            "cách chốt sổ trong ứng dụng",
            "Hướng dẫn kiểm quỹ",
            "How do I close the day?",
            "What is today's revenue?",
            "Show electricity expenses",
            "How much stock is left?",
            "How many Pepsi sold yesterday?",
        ] {
            assert!(!seller_day_close(Role::Seller, input), "{input}");
        }
    }
}
