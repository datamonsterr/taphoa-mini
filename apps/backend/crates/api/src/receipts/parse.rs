use super::{LineCandidate, OcrText};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

/// Parse integer đồng amounts and quantities while preserving OCR positions and names.
/// A lone final price is an amount; explicit `ĐG`/`đơn giá` marks a unit-only price.
/// Monetary total/payment rows remain candidates for the role decision or rule fallback.
pub fn parse_lines(lines: &[OcrText]) -> Vec<LineCandidate> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(position, line)| parse_line(position, &line.text))
        .collect()
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .map(|c| if c == 'đ' { 'd' } else { c })
        .collect()
}

pub(super) fn keyword_role(text: &str) -> &'static str {
    let normalized = normalized(text);
    let words = normalized
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let padded = format!(" {words} ");
    if [
        "tong",
        "cong",
        "thanh toan",
        "tien mat",
        "chiet khau",
        "giam gia",
        "thoi",
        "vat",
        "thue",
    ]
    .iter()
    .any(|word| padded.contains(&format!(" {word} ")))
    {
        "total"
    } else {
        "item"
    }
}

fn money(token: &str) -> Option<i64> {
    let lower = token.to_lowercase();
    let number = lower
        .strip_suffix("vnd")
        .or_else(|| lower.strip_suffix('đ'))
        .or_else(|| lower.strip_suffix('₫'))
        .unwrap_or(&lower);
    if number.is_empty() {
        return None;
    }
    let separator = if number.contains('.') {
        Some('.')
    } else if number.contains(',') {
        Some(',')
    } else {
        None
    };
    if let Some(separator) = separator {
        let groups: Vec<_> = number.split(separator).collect();
        if groups[0].is_empty()
            || groups[0].len() > 3
            || groups.iter().skip(1).any(|g| g.len() != 3)
        {
            return None;
        }
        if groups
            .iter()
            .any(|g| !g.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        groups.concat().parse().ok()
    } else if number.bytes().all(|b| b.is_ascii_digit()) {
        number.parse().ok()
    } else {
        None
    }
}

fn positive_quantity(text: &str) -> Result<i32, ()> {
    text.parse::<i32>().ok().filter(|qty| *qty > 0).ok_or(())
}
fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn take_quantity(words: &mut Vec<&str>) -> Result<Option<i32>, ()> {
    for i in 0..words.len() {
        let token = normalized(words[i]);
        if let Some(number) = token
            .strip_prefix('x')
            .or_else(|| token.strip_prefix('×'))
            .filter(|number| digits(number))
        {
            let quantity = positive_quantity(number)?;
            words.remove(i);
            return Ok(Some(quantity));
        }
        if token == "sl" {
            let quantity = positive_quantity(words.get(i + 1).ok_or(())?)?;
            words.drain(i..=i + 1);
            return Ok(Some(quantity));
        }
        if let Some(number) = token.strip_prefix("sl:").filter(|number| digits(number)) {
            let quantity = positive_quantity(number)?;
            words.remove(i);
            return Ok(Some(quantity));
        }
        if digits(words[i])
            && words.get(i + 1).is_some_and(|unit| {
                ["thung", "hop", "lon", "chai", "goi", "cai"].contains(&normalized(unit).as_str())
            })
        {
            let quantity = positive_quantity(words[i])?;
            words.drain(i..=i + 1);
            return Ok(Some(quantity));
        }
    }
    if words.first().is_some_and(|text| digits(text)) {
        return positive_quantity(words.remove(0)).map(Some);
    }
    Ok(None)
}

fn parse_line(position: usize, text: &str) -> Option<LineCandidate> {
    let mut words: Vec<_> = text
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| matches!(c, '|' | ':' | ';' | '*')))
        .filter(|word| !word.is_empty())
        .collect();
    if words
        .last()
        .is_some_and(|word| matches!(normalized(word).as_str(), "vnd" | "d" | "dong" | "₫"))
    {
        words.pop();
    }
    let amount = money(words.pop()?)?;
    let mut unit_only = false;
    if words.last().is_some_and(|word| normalized(word) == "dg") {
        words.pop();
        unit_only = true;
    } else if words.len() >= 2
        && normalized(words[words.len() - 2]) == "don"
        && normalized(words[words.len() - 1]) == "gia"
    {
        words.truncate(words.len() - 2);
        unit_only = true;
    }
    let mut quantity = take_quantity(&mut words).ok()?;
    let mut unit_price = unit_only.then_some(amount);
    if !unit_only && let Some(token) = words.last().copied() {
        let price = money(token);
        let previous_number = words.len() >= 2 && digits(words[words.len() - 2]);
        // Without a quantity, grouped/currency prices or large bare integers identify a unit column.
        if price.is_some()
            && (quantity.is_some()
                || previous_number
                || token.contains(['.', ','])
                || token.ends_with(['đ', '₫'])
                || price.is_some_and(|p| p >= 1000))
        {
            unit_price = price;
            words.pop();
        }
    }
    if quantity.is_none() && words.last().is_some_and(|word| digits(word)) {
        quantity = Some(positive_quantity(words.pop()?).ok()?);
    }
    if !unit_only
        && quantity.is_none()
        && let Some(unit) = unit_price.filter(|unit| *unit > 0 && amount > 0 && amount % unit == 0)
    {
        quantity = Some(i32::try_from(amount / unit).ok()?);
    }
    let quantity = quantity.unwrap_or(1);
    let product_name = words
        .join(" ")
        .trim_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '|' | '-' | ';' | '*'))
        .to_owned();
    if !product_name.chars().any(char::is_alphabetic) {
        return None;
    }
    let cost = if unit_only {
        amount.checked_mul(i64::from(quantity))?
    } else {
        amount
    };
    Some(LineCandidate {
        position,
        raw_text: text.into(),
        product_name,
        quantity,
        cost,
        unit_price,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn ocr(text: &str) -> OcrText {
        OcrText {
            text: text.into(),
            confidence: 0.99,
            bbox: [0.; 4],
        }
    }

    #[test]
    fn money_formats() {
        for money in ["204.000", "204,000", "204000", "204.000đ", "204.000 VND"] {
            let parsed = parse_lines(&[ocr(&format!("Coca-Cola lon 330ml x24 {money}"))]);
            assert_eq!(parsed.len(), 1, "{money}");
            assert_eq!(
                (&*parsed[0].product_name, parsed[0].quantity, parsed[0].cost),
                ("Coca-Cola lon 330ml", 24, 204000)
            );
        }
    }

    #[test]
    fn quantities_and_layouts() {
        for qty in [
            "x24",
            "SL 24",
            "SL: 24",
            "24 thùng",
            "24 hộp",
            "24 lon",
            "24 chai",
            "24 gói",
            "24 cái",
            "24",
        ] {
            let parsed = parse_lines(&[ocr(&format!("Coca-Cola lon 330ml {qty} 204.000"))]);
            assert_eq!(
                (&*parsed[0].product_name, parsed[0].quantity, parsed[0].cost),
                ("Coca-Cola lon 330ml", 24, 204000),
                "{qty}"
            );
        }
        for (text, name, qty, amount) in [
            (
                "12 Sữa tươi Vinamilk 180ml 84.000",
                "Sữa tươi Vinamilk 180ml",
                12,
                84000,
            ),
            (
                "Dầu ăn Neptune 1L x6 312.000",
                "Dầu ăn Neptune 1L",
                6,
                312000,
            ),
            (
                " | Coca-Cola lon 330ml 24 8.500 204.000 | ",
                "Coca-Cola lon 330ml",
                24,
                204000,
            ),
            (
                "Coca-Cola lon 330ml 8.500 204.000",
                "Coca-Cola lon 330ml",
                24,
                204000,
            ),
            (
                "Coca-Cola lon 330ml x24 ĐG 8.500",
                "Coca-Cola lon 330ml",
                24,
                204000,
            ),
            (
                "Coca-Cola lon 330ml 24 đơn giá 8.500",
                "Coca-Cola lon 330ml",
                24,
                204000,
            ),
            (
                "Coca-Cola lon 330ml 24 500 12.000",
                "Coca-Cola lon 330ml",
                24,
                12000,
            ),
            (
                "Coca-Cola lon 330ml 204.000",
                "Coca-Cola lon 330ml",
                1,
                204000,
            ),
        ] {
            let parsed = parse_lines(&[ocr(text)]);
            assert_eq!(parsed.len(), 1, "{text}");
            assert_eq!(
                (&*parsed[0].product_name, parsed[0].quantity, parsed[0].cost),
                (name, qty, amount),
                "{text}"
            );
        }
    }

    #[tokio::test]
    async fn fixture_items_keep_names_and_original_positions() {
        let lines = [
            "ĐẠI LÝ TẠP HÓA MINH ANH",
            "12 Nguyễn Trãi, 0.1, TPHCM",
            "HÓA ĐƠN BÁN HÀNG 25/10/2026",
            "Tên hàng SL Đơn giá T. Tiền",
            "Coca-Cola lon 330ml 24 8.500 204.000",
            "Mì Hảo Hảo tôm chua cay 30 4.200 126.000",
            "Nước suối Aquafina 500ml 12 5.000 60.000",
            "Bánh Chocopie hộp 5 13.200 66.000",
            "Tổng cộng: 456.000",
            "Cảm ơn quý kháchl",
        ]
        .map(ocr);
        let parsed = parse_lines(&lines);
        let mapped = crate::receipts::map_lines(None, &parsed, &[]).await;
        assert_eq!(
            mapped
                .lines
                .iter()
                .map(|l| (
                    &*l.candidate.product_name,
                    l.candidate.quantity,
                    l.candidate.cost,
                    l.candidate.position,
                    l.candidate.unit_price
                ))
                .collect::<Vec<_>>(),
            vec![
                ("Coca-Cola lon 330ml", 24, 204000, 4, Some(8500)),
                ("Mì Hảo Hảo tôm chua cay", 30, 126000, 5, Some(4200)),
                ("Nước suối Aquafina 500ml", 12, 60000, 6, Some(5000)),
                ("Bánh Chocopie hộp", 5, 66000, 7, Some(13200)),
            ]
        );
    }

    #[test]
    fn fallback_keywords_are_case_and_accent_insensitive() {
        for word in [
            "TỔNG",
            "cộng",
            "THANH TOÁN",
            "tiền mặt",
            "chiết khấu",
            "GIẢM GIÁ",
            "thối",
            "VAT",
            "thuế",
            "Tong",
            "CONG",
            "chiet khau",
            "thue",
            "Va\u{0300}t",
        ] {
            assert_ne!(keyword_role(&format!("{word}: 204.000")), "item", "{word}");
        }
        assert_ne!(keyword_role("Số tiền thanh toán: 204.000"), "item");
        assert_eq!(keyword_role("Bánh cộng đồng 24 204.000"), "total");
        assert_eq!(keyword_role("Vatican chocolate 24 204.000"), "item");
    }

    #[test]
    fn malformed_and_overflow_lines_are_safe() {
        for text in [
            "name x24",
            "",
            "204.000",
            "name 20.40",
            "name -1000",
            "name 999999999999999999999999999",
            "name x0 1000",
            "name x99999999999 1000",
            "name x2147483647 ĐG 9999999999999999",
        ] {
            assert!(parse_lines(&[ocr(text)]).is_empty(), "{text}");
        }
        let parsed = parse_lines(&[ocr("name 8.500 204.001")]);
        assert_eq!(parsed[0].quantity, 1);
        assert_eq!(parsed[0].cost, 204001);
    }
}
