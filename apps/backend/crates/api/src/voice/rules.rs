//! Pure re-check of what the speech model parsed (voice.md "Price and quantity rules").
//! Spoken amounts are re-read from the model's `price_spoken` words, so a wrong digit count
//! from the model cannot reach the sale. No I/O.
use super::text::fold;

pub const MIN_QUANTITY: i64 = 1;
pub const MAX_QUANTITY: i64 = 999;
pub const MIN_PRICE: i64 = 500;
pub const MAX_PRICE: i64 = 50_000_000;

/// Result of reading a spoken amount. `scaled` is true when the words named a scale
/// (nghìn, ngàn, triệu, "k"), so the value is already in dong.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpokenAmount {
    pub value: f64,
    pub scaled: bool,
}

/// Quantity check: an integer in 1..=999. Anything else (fractions such as "nửa ký", zero,
/// 1,000) makes the line manual because `SaleLineInput.quantity` is an integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quantity {
    Count(i32),
    Manual,
}

pub fn check_quantity(quantity: Option<f64>) -> Quantity {
    let Some(q) = quantity else {
        return Quantity::Count(1); // "no number before a product"
    };
    if !q.is_finite() || (q - q.round()).abs() > 1e-6 {
        return Quantity::Manual;
    }
    let q = q.round() as i64;
    if (MIN_QUANTITY..=MAX_QUANTITY).contains(&q) {
        Quantity::Count(q as i32)
    } else {
        Quantity::Manual
    }
}

/// Canonical weight unit of a spoken unit ("ký", "kí", "kilo", "cân" are kg), if it is one.
pub fn weight_unit(unit: &str) -> Option<&'static str> {
    Some(match fold(unit).as_str() {
        "kg" | "ky" | "ki" | "ki lo" | "kilo" | "can" => "kg",
        "lang" => "lang",
        "g" | "gram" | "gam" => "g",
        "yen" => "yen",
        "ta" => "ta",
        "tan" => "tan",
        _ => return None,
    })
}

/// True for units sold by weight; they map to the product's base unit only when it is the
/// same weight unit, otherwise the line is manual.
pub fn is_weight_unit(unit: &str) -> bool {
    weight_unit(unit).is_some()
}

fn digit_word(token: &str) -> Option<u32> {
    Some(match token {
        "khong" => 0,
        "mot" | "mot1" => 1,
        "hai" => 2,
        "ba" => 3,
        "bon" | "tu" => 4,
        "nam" | "lam" => 5,
        "sau" => 6,
        "bay" => 7,
        "tam" => 8,
        "chin" => 9,
        _ => return None,
    })
}

/// Read an amount from spoken words or digits: "hai mươi nghìn", "20k", "20 nghìn",
/// "hai chục", "hai lăm", "mười rưỡi", "trăm rưỡi", "1.500.000", "hai trăm".
pub fn parse_spoken_amount(text: &str) -> Option<SpokenAmount> {
    let folded = fold(text);
    // "20k" is one folded token; split a trailing k from digits.
    let mut tokens: Vec<String> = Vec::new();
    for raw in folded.split(' ').filter(|t| !t.is_empty()) {
        if let Some(num) = raw
            .strip_suffix('k')
            .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        {
            tokens.push(num.to_owned());
            tokens.push("nghin".into());
        } else {
            tokens.push(raw.to_owned());
        }
    }
    // Digits keep their separators before folding turned them into spaces, so re-read them
    // from the original text when the whole input is a plain number.
    if let Some(value) = plain_number(text) {
        return Some(SpokenAmount {
            value,
            scaled: value >= 1000.0,
        });
    }
    let mut total = 0.0_f64;
    let mut current = 0.0_f64;
    let mut pending: Option<f64> = None;
    let mut last_scale = 0.0_f64; // value of the last scale word, for "rưỡi"
    let mut scaled = false;
    let mut seen = false;
    for token in &tokens {
        let t = token.as_str();
        if let Ok(n) = t.parse::<f64>() {
            // Two bare digits in a row are tens and units: "hai lăm" -> 25.
            pending = Some(match pending {
                Some(p) if p < 10.0 && n < 10.0 => p * 10.0 + n,
                Some(p) => {
                    current += p;
                    n
                }
                None => n,
            });
            seen = true;
        } else if let Some(d) = digit_word(t) {
            let d = f64::from(d);
            pending = Some(match pending {
                Some(p) if p < 10.0 && d < 10.0 => p * 10.0 + d,
                Some(p) => {
                    current += p;
                    d
                }
                None => d,
            });
            seen = true;
        } else {
            match t {
                "muoi" | "chuc" => {
                    current += pending.take().unwrap_or(1.0) * 10.0;
                    last_scale = 10.0;
                }
                "tram" => {
                    current += pending.take().unwrap_or(1.0) * 100.0;
                    last_scale = 100.0;
                }
                "linh" | "le" => {}
                "nghin" | "ngan" => {
                    total += (current + pending.take().unwrap_or(0.0)) * 1000.0;
                    current = 0.0;
                    last_scale = 1000.0;
                    scaled = true;
                }
                "trieu" | "tr" => {
                    total += (current + pending.take().unwrap_or(0.0)) * 1_000_000.0;
                    current = 0.0;
                    last_scale = 1_000_000.0;
                    scaled = true;
                }
                "ruoi" => {
                    // A half of the last scale word; after tens it is half a unit ("mười rưỡi").
                    if last_scale == 0.0 {
                        return None;
                    }
                    let half = if last_scale <= 10.0 {
                        0.5
                    } else {
                        last_scale / 2.0
                    };
                    if last_scale >= 1000.0 {
                        total += half;
                    } else {
                        current += half;
                    }
                    if let Some(p) = pending.take() {
                        current += p;
                    }
                }
                "dong" | "d" | "vnd" | "tien" | "gia" | "la" | "hon" | "khoang" => {}
                _ => return None,
            }
            seen = true;
        }
    }
    if !seen {
        return None;
    }
    let value = total + current + pending.unwrap_or(0.0);
    (value > 0.0).then_some(SpokenAmount { value, scaled })
}

/// "20000", "20.000", "1.500.000", "20,5" as a whole-input number.
fn plain_number(text: &str) -> Option<f64> {
    let t: String = text.trim().trim_end_matches(['đ', 'd']).trim().to_owned();
    if t.is_empty()
        || !t
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    {
        return None;
    }
    let groups: Vec<&str> = t.split(['.', ',']).collect();
    let grouped = groups.len() > 1
        && !groups[0].is_empty()
        && groups[0].len() <= 3
        && groups[1..].iter().all(|g| g.len() == 3);
    if grouped || groups.len() == 1 {
        return groups.concat().parse().ok();
    }
    t.replace(',', ".").parse().ok()
}

/// Dong value of a spoken amount. A bare number under 1,000 is thousands unless it equals the
/// catalog price (and is a valid price). "200 is never a price" falls out of the range check.
pub fn amount_in_dong(amount: SpokenAmount, catalog_price: Option<i64>) -> Option<i64> {
    let value = amount.value;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    if !amount.scaled && value < 1000.0 {
        let bare = value.round() as i64;
        if (value - value.round()).abs() < 1e-9 && catalog_price == Some(bare) && bare >= MIN_PRICE
        {
            return Some(bare);
        }
        return Some((value * 1000.0).round() as i64);
    }
    Some(value.round() as i64)
}

pub fn price_in_range(price: i64) -> bool {
    (MIN_PRICE..=MAX_PRICE).contains(&price)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceSource {
    Spoken,
    Catalog,
    None,
}
impl PriceSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spoken => "spoken",
            Self::Catalog => "catalog",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriceDecision {
    pub unit_price: Option<i64>,
    pub source: PriceSource,
    pub mismatch: bool,
    pub needs_price: bool,
}

/// What the model said about the price of one line.
#[derive(Debug, Clone, Copy)]
pub struct SpokenPrice<'a> {
    pub words: Option<&'a str>,
    pub model_value: Option<f64>,
}

/// Keep the model's price only when it was really spoken: `price_spoken` must be non-empty and
/// every word or digit group of it must occur in the transcript. Some models echo the catalog
/// price as `unit_price` with `price_spoken` null; that is not a spoken price.
pub fn spoken_price<'a>(
    words: Option<&'a str>,
    model_value: Option<f64>,
    transcript: &str,
) -> SpokenPrice<'a> {
    let words = words.map(str::trim).filter(|w| !w.is_empty());
    let transcript_tokens: std::collections::HashSet<String> =
        fold(transcript).split(' ').map(str::to_owned).collect();
    let grounded = words.is_some_and(|w| {
        let folded = fold(w);
        !folded.is_empty() && folded.split(' ').all(|t| transcript_tokens.contains(t))
    });
    if grounded {
        SpokenPrice { words, model_value }
    } else {
        SpokenPrice {
            words: None,
            model_value: None,
        }
    }
}

/// Whether a parsed line was really said: its `spoken` (or `query`) text shares a word with the
/// transcript. Models that hallucinate on silence invent lines with no basis in the words.
pub fn line_is_grounded(spoken: &str, query: &str, transcript: &str) -> bool {
    let transcript_tokens: std::collections::HashSet<String> = fold(transcript)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    [spoken, query].iter().any(|text| {
        fold(text)
            .split(' ')
            .any(|t| !t.is_empty() && transcript_tokens.contains(t))
    })
}

/// Decide the unit price of one line.
/// - The spoken price is re-read from the words when they parse, else the model's number
///   (also under the thousands rule).
/// - Out-of-range spoken prices are dropped.
/// - With quantity above 1 and a spoken price equal to catalog price times quantity, the
///   seller said the line total: unit price is the catalog price, no mismatch.
/// - Otherwise a spoken price different from the catalog price sets `mismatch`.
pub fn decide_price(
    spoken: SpokenPrice<'_>,
    quantity: i32,
    catalog_price: Option<i64>,
) -> PriceDecision {
    let catalog_price = catalog_price.filter(|p| *p > 0);
    let from_words = spoken
        .words
        .and_then(parse_spoken_amount)
        .and_then(|a| amount_in_dong(a, catalog_price));
    let from_model = spoken
        .model_value
        .filter(|v| v.is_finite() && *v > 0.0)
        .and_then(|v| {
            amount_in_dong(
                SpokenAmount {
                    value: v,
                    scaled: v >= 1000.0,
                },
                catalog_price,
            )
        });
    let spoken_price = from_words.or(from_model).filter(|p| price_in_range(*p));
    match (spoken_price, catalog_price) {
        (Some(price), Some(catalog)) => {
            if quantity > 1 && price == catalog.saturating_mul(i64::from(quantity)) {
                PriceDecision {
                    unit_price: Some(catalog),
                    source: PriceSource::Spoken,
                    mismatch: false,
                    needs_price: false,
                }
            } else {
                PriceDecision {
                    unit_price: Some(price),
                    source: PriceSource::Spoken,
                    mismatch: price != catalog,
                    needs_price: false,
                }
            }
        }
        (Some(price), None) => PriceDecision {
            unit_price: Some(price),
            source: PriceSource::Spoken,
            mismatch: false,
            needs_price: false,
        },
        (None, Some(catalog)) => PriceDecision {
            unit_price: Some(catalog),
            source: PriceSource::Catalog,
            mismatch: false,
            needs_price: false,
        },
        (None, None) => PriceDecision {
            unit_price: None,
            source: PriceSource::None,
            mismatch: false,
            needs_price: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dong(words: &str, catalog: Option<i64>) -> Option<i64> {
        parse_spoken_amount(words).and_then(|a| amount_in_dong(a, catalog))
    }

    #[test]
    fn table_spoken_amounts() {
        assert_eq!(dong("hai mươi nghìn", None), Some(20_000));
        assert_eq!(dong("20 nghìn", None), Some(20_000));
        assert_eq!(dong("20k", None), Some(20_000));
        assert_eq!(dong("hai chục", None), Some(20_000));
        assert_eq!(dong("hai lăm", None), Some(25_000));
        assert_eq!(dong("hai mươi lăm", None), Some(25_000));
        assert_eq!(dong("mười rưỡi", None), Some(10_500));
        assert_eq!(dong("trăm rưỡi", None), Some(150_000));
        assert_eq!(dong("một trăm rưỡi", None), Some(150_000));
        assert_eq!(dong("hai trăm", None), Some(200_000));
        assert_eq!(dong("hai mươi", None), Some(20_000));
        assert_eq!(dong("mười lăm nghìn", None), Some(15_000));
        assert_eq!(dong("một triệu rưỡi", None), Some(1_500_000));
        assert_eq!(dong("ba nghìn rưỡi", None), Some(3_500));
        assert_eq!(dong("20000", None), Some(20_000));
        assert_eq!(dong("1.500.000", None), Some(1_500_000));
        assert_eq!(dong("blah", None), None);
        assert_eq!(dong("", None), None);
    }

    #[test]
    fn bare_number_equal_to_catalog_price_is_not_thousands() {
        // "năm trăm" = 500 and the catalog says 500: the price is 500, not 500,000.
        assert_eq!(dong("năm trăm", Some(500)), Some(500));
        assert_eq!(dong("năm trăm", Some(5_000)), Some(500_000));
        // 200 is below the minimum price, so it is still thousands.
        assert_eq!(dong("hai trăm", Some(200)), Some(200_000));
    }

    #[test]
    fn quantity_ranges() {
        assert_eq!(check_quantity(None), Quantity::Count(1));
        assert_eq!(check_quantity(Some(3.0)), Quantity::Count(3));
        assert_eq!(check_quantity(Some(999.0)), Quantity::Count(999));
        assert_eq!(check_quantity(Some(1000.0)), Quantity::Manual);
        assert_eq!(check_quantity(Some(0.0)), Quantity::Manual);
        assert_eq!(check_quantity(Some(-2.0)), Quantity::Manual);
        assert_eq!(check_quantity(Some(0.5)), Quantity::Manual); // nửa ký
        assert_eq!(check_quantity(Some(f64::NAN)), Quantity::Manual);
    }

    #[test]
    fn weight_units() {
        for unit in ["ký", "kg", "lạng", "gram", "cân"] {
            assert!(is_weight_unit(unit), "{unit}");
        }
        for unit in ["chai", "gói", "thùng", "lon"] {
            assert!(!is_weight_unit(unit), "{unit}");
        }
    }

    #[test]
    fn price_per_item_when_quantity_and_price_are_spoken() {
        // "ba cái năm nghìn": quantity 3, unit price 5,000.
        let d = decide_price(
            SpokenPrice {
                words: Some("năm nghìn"),
                model_value: Some(5000.0),
            },
            3,
            Some(5_000),
        );
        assert_eq!(d.unit_price, Some(5_000));
        assert!(!d.mismatch && !d.needs_price);
        assert_eq!(d.source, PriceSource::Spoken);
    }

    #[test]
    fn line_total_equal_to_catalog_times_quantity_is_a_total() {
        // "ba cái mười lăm nghìn", catalog 5,000: line total 15,000 -> unit 5,000.
        let d = decide_price(
            SpokenPrice {
                words: Some("mười lăm nghìn"),
                model_value: Some(15_000.0),
            },
            3,
            Some(5_000),
        );
        assert_eq!(d.unit_price, Some(5_000));
        assert!(!d.mismatch);
    }

    #[test]
    fn otherwise_unit_price_is_spoken_with_mismatch() {
        let d = decide_price(
            SpokenPrice {
                words: Some("mười lăm nghìn"),
                model_value: Some(15_000.0),
            },
            3,
            Some(4_000),
        );
        assert_eq!(d.unit_price, Some(15_000));
        assert!(d.mismatch);
        // Quantity 1 and the same price as the catalog: no mismatch.
        let d = decide_price(
            SpokenPrice {
                words: Some("hai mươi nghìn"),
                model_value: None,
            },
            1,
            Some(20_000),
        );
        assert_eq!(d.unit_price, Some(20_000));
        assert!(!d.mismatch);
    }

    #[test]
    fn missing_price_falls_back_to_catalog_then_needs_price() {
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: None,
            },
            2,
            Some(7_000),
        );
        assert_eq!(
            (d.unit_price, d.source),
            (Some(7_000), PriceSource::Catalog)
        );
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: None,
            },
            2,
            None,
        );
        assert_eq!(
            (d.unit_price, d.source, d.needs_price),
            (None, PriceSource::None, true)
        );
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: None,
            },
            2,
            Some(0),
        );
        assert!(d.needs_price);
    }

    #[test]
    fn out_of_range_prices_are_dropped() {
        // 100,000,000 is above the maximum price.
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: Some(100_000_000.0),
            },
            1,
            Some(9_000),
        );
        assert_eq!(
            (d.unit_price, d.source),
            (Some(9_000), PriceSource::Catalog)
        );
        // 100 -> 100,000 by the thousands rule, which is in range.
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: Some(100.0),
            },
            1,
            None,
        );
        assert_eq!(d.unit_price, Some(100_000));
        // Below the minimum even after nothing applies.
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: Some(0.2),
            },
            1,
            None,
        );
        assert!(d.needs_price);
    }

    #[test]
    fn model_price_without_spoken_words_is_not_spoken() {
        // The model echoed the catalog price: no price_spoken, so it is dropped.
        let sp = spoken_price(None, Some(8000.0), "một chai nước suối lavie");
        assert!(sp.words.is_none() && sp.model_value.is_none());
        let sp = spoken_price(Some("  "), Some(8000.0), "một chai nước suối lavie");
        assert!(sp.model_value.is_none());
        let d = decide_price(sp, 1, Some(8000));
        assert_eq!(d.source, PriceSource::Catalog);
    }

    #[test]
    fn price_words_must_occur_in_the_transcript() {
        let said = "hai chai tương ớt hai mươi nghìn";
        let sp = spoken_price(Some("hai mươi nghìn"), Some(20000.0), said);
        assert_eq!(sp.model_value, Some(20000.0));
        assert_eq!(sp.words, Some("hai mươi nghìn"));
        // Words the speaker never said.
        let sp = spoken_price(Some("ba mươi nghìn"), Some(30000.0), said);
        assert!(sp.words.is_none() && sp.model_value.is_none());
        // Digits and accents are normalized.
        let sp = spoken_price(Some("20K"), Some(20000.0), "hai chai 20k");
        assert_eq!(sp.model_value, Some(20000.0));
        let sp = spoken_price(Some("HAI MƯƠI NGHÌN"), None, said);
        assert!(sp.words.is_some());
    }

    #[test]
    fn grounded_lines_share_a_word_with_the_transcript() {
        let t = "hai lon bia tiger";
        assert!(line_is_grounded("hai lon bia tiger", "bia tiger", t));
        assert!(line_is_grounded("", "tiger", t));
        assert!(!line_is_grounded("gói mì hảo hảo", "hảo hảo", t));
        assert!(!line_is_grounded("bia tiger", "tiger", ""));
        assert!(!line_is_grounded("", "", t));
    }

    #[test]
    fn model_number_used_when_words_do_not_parse() {
        let d = decide_price(
            SpokenPrice {
                words: Some("giá rẻ bèo"),
                model_value: Some(12_000.0),
            },
            1,
            None,
        );
        assert_eq!(d.unit_price, Some(12_000));
    }

    #[test]
    fn bare_model_number_is_thousands() {
        let d = decide_price(
            SpokenPrice {
                words: None,
                model_value: Some(20.0),
            },
            1,
            None,
        );
        assert_eq!(d.unit_price, Some(20_000));
    }
}
