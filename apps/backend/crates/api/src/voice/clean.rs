//! Deterministic product-name cleaning for spoken lines (issue #152).
//!
//! The model is told to keep quantity, unit and price out of spoken and query, but it
//! slips (for example a pack of bi cakes said with a count and a price). This step makes
//! the rule hold regardless: the name keeps only the product words, and what it removes is
//! handed back so the quantity and unit land in their own fields when the model left them
//! empty.
//!
//! All word lists hold folded text (no diacritics, lowercase) and are compared against
//! fold(token), so goi, gói and GÓI are the same word.
use super::text::fold;

/// A spoken line split into the product name and the words that were around it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Cleaned {
    /// Product words only, original spelling and diacritics, in spoken order.
    pub name: String,
    /// Quantity read from leading digits or number words.
    pub quantity: Option<f64>,
    /// First unit or container word removed.
    pub unit: Option<String>,
}

/// Words that open a sentence but are not part of a product name.
const FILLERS: &[&str] = &[
    "cho", "lay", "mua", "ban", "them", "ghi", "toi", "em", "anh", "chi", "minh", "oi", "nua",
    "voi", "va", "cua", "it", "mon", "san", "pham", "hang", "loai", "mot",
];
/// Unit, container and weight words. Removed wherever they stand in the name.
const UNITS: &[&str] = &[
    "chai", "lon", "goi", "hop", "thung", "bich", "cai", "bao", "kien", "tui", "cay", "ly", "coc",
    "vi", "bo", "lo", "can", "binh", "tuyp", "hu", "chiec", "con", "cuon", "phan", "to", "dia",
    "kg", "ky", "kilo", "lang", "yen", "ta", "tan", "lit", "loc", "tep", "xau", "thanh", "mieng",
    "vien", "cap", "doi", "chuc", "bang",
];
/// Number words that carry a digit value.
const DIGITS: &[(&str, f64)] = &[
    ("mot", 1.0),
    ("hai", 2.0),
    ("ba", 3.0),
    ("bon", 4.0),
    ("tu", 4.0),
    ("nam", 5.0),
    ("lam", 5.0),
    ("sau", 6.0),
    ("bay", 7.0),
    ("tam", 8.0),
    ("chin", 9.0),
];
/// Number and price words that never belong in a name.
const NUMBER_WORDS: &[&str] = &[
    "mot", "hai", "ba", "bon", "tu", "nam", "lam", "sau", "bay", "tam", "chin", "muoi", "linh",
    "le", "tram", "nghin", "ngan", "chuc", "ruoi", "trieu", "k", "dong", "vnd",
];
/// Words that introduce a price, such as gia (price) or tong (total).
const PRICE_WORDS: &[&str] = &["gia", "la", "het", "tong", "tien", "mac", "moi"];
/// Size units that stay attached to a number (330 ml becomes 330ml).
const SIZE_UNITS: &[&str] = &["ml", "l", "g", "gr", "gam", "cl"];
/// Container and weight words that are never part of a product name, so they are dropped
/// even in the middle of it. Words like bao (bánh bao) only count at the edges.
const STRICT_UNITS: &[&str] = &[
    "chai", "lon", "goi", "hop", "thung", "bich", "kien", "tui", "kg",
];

fn in_list(list: &[&str], token: &str) -> bool {
    list.contains(&token)
}
fn is_digits(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|c| c.is_ascii_digit())
}
fn is_number_word(token: &str) -> bool {
    in_list(NUMBER_WORDS, token)
}

fn is_num_char(c: char) -> bool {
    c.is_ascii_digit() || c == char::from(46u8) || c == char::from(44u8)
}

/// A price-looking amount such as 15.000, 15000, 20k or 20.000đ. A bare short number
/// (333, 7) is not one, it may be part of a name.
fn is_price_amount(raw: &str) -> bool {
    let lower = raw
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase();
    let end = lower.find(|c: char| !is_num_char(c)).unwrap_or(lower.len());
    if end == 0 {
        return false;
    }
    let (number, suffix) = lower.split_at(end);
    let has_sep = number.chars().any(|c| !c.is_ascii_digit());
    let suffix = fold(suffix);
    if suffix.is_empty() {
        return number.len() >= 4 || has_sep;
    }
    ["k", "d", "dong", "vnd", "nghin", "ngan"].contains(&suffix.as_str())
}

struct Token {
    raw: String,
    folded: String,
}

fn tokenize(text: &str) -> Vec<Token> {
    text.split_whitespace()
        .filter_map(|raw| {
            let trimmed = raw.trim_matches(|c: char| !c.is_alphanumeric());
            (!trimmed.is_empty()).then(|| Token {
                raw: trimmed.to_owned(),
                folded: fold(trimmed),
            })
        })
        .collect()
}

fn word_value(token: &str) -> Option<f64> {
    if is_digits(token) {
        return token.parse().ok().filter(|n: &f64| *n < 1000.0);
    }
    DIGITS.iter().find(|(w, _)| *w == token).map(|(_, n)| *n)
}

/// Read a leading quantity and return how many tokens it covers and its value.
fn leading_quantity(tokens: &[Token]) -> Option<(usize, f64)> {
    let word = |i: usize| tokens.get(i).map(|t| t.folded.as_str());
    let ones = |i: usize| ones_at(tokens, i);
    let first = word(0)?;
    if first == "muoi" {
        return Some(ones(1).map_or((1, 10.0), |n| (2, 10.0 + n)));
    }
    let n = word_value(first)?;
    if !is_digits(first) && word(1) == Some("muoi") {
        return Some(ones(2).map_or((2, n * 10.0), |extra| (3, n * 10.0 + extra)));
    }
    if first == "mot" && word(1) == Some("chuc") {
        return Some((2, 10.0));
    }
    Some((1, n))
}

fn ones_at(tokens: &[Token], i: usize) -> Option<f64> {
    let w = tokens.get(i)?.folded.as_str();
    let v = word_value(w)?;
    (v < 10.0 && !is_digits(w)).then_some(v)
}

fn is_filler_like(token: &Token) -> bool {
    in_list(FILLERS, &token.folded) || is_number_word(&token.folded) || is_price_amount(&token.raw)
}

fn unit_of(token: &Token) -> String {
    token.raw.to_lowercase()
}

/// Clean one phrase. The result may have an empty name when nothing but noise was said.
pub fn clean_phrase(text: &str) -> Cleaned {
    let tokens = tokenize(text);
    let mut out = Cleaned::default();
    let mut start = 0;
    // Leading run: fillers, quantity and unit words.
    while start < tokens.len() {
        let token = &tokens[start];
        if let Some((used, value)) = leading_quantity(&tokens[start..]) {
            out.quantity.get_or_insert(value);
            start += used;
        } else if in_list(UNITS, &token.folded) {
            out.unit.get_or_insert_with(|| unit_of(token));
            start += 1;
        } else if is_filler_like(token) {
            start += 1;
        } else {
            break;
        }
    }
    // Trailing run: price words and amounts.
    let mut end = tokens.len();
    while end > start && is_tail(&tokens, start, end) {
        end -= 1;
    }
    out.name = build_body(&tokens[start..end], &mut out);
    out
}

fn is_amount_token(t: &Token) -> bool {
    is_price_amount(&t.raw) || is_number_word(&t.folded)
}

fn is_amount_or_bare(t: &Token) -> bool {
    is_amount_token(t) || t.folded.chars().all(|c| c.is_ascii_digit())
}

/// Whether the last token before end belongs to a trailing price phrase.
fn is_tail(tokens: &[Token], start: usize, end: usize) -> bool {
    let token = &tokens[end - 1];
    if is_amount_token(token) {
        return true;
    }
    // A bare number said before an amount word, like 20 then nghin, is a price.
    if is_digits(&token.folded) && tokens.get(end).is_some_and(is_amount_token) {
        return true;
    }
    // Gia (price) and la (is) count only in front of an amount.
    if in_list(PRICE_WORDS, &token.folded) && end < tokens.len() {
        return tokens[end..].iter().all(is_amount_or_bare);
    }
    // A unit word counts after an amount, as in a price said with a currency word.
    in_list(UNITS, &token.folded) && end - 1 > start && is_number_word(&tokens[end - 2].folded)
}

fn is_unit(t: &Token) -> bool {
    in_list(STRICT_UNITS, &t.folded)
}

/// A name without quantity, unit and price: the safe form to show, store or match.
pub fn clean_name(text: &str) -> String {
    clean_phrase(text).name
}

/// The product words of the middle part: unit words and loose prices are dropped and a
/// number followed by a size unit is joined, so 330 ml becomes 330ml.
fn build_body(body: &[Token], out: &mut Cleaned) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut skip_next = false;
    for (i, token) in body.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        let next = body.get(i + 1);
        let prev_unit = i > 0 && is_unit(&body[i - 1]);
        let next_unit = next.is_some_and(is_unit);
        let size_next = next.is_some_and(|n| in_list(SIZE_UNITS, &n.folded));
        if is_digits(&token.folded) && size_next {
            let size = next.map_or(String::new(), |n| n.raw.to_lowercase());
            kept.push([token.raw.as_str(), size.as_str()].concat());
            skip_next = true;
        } else if is_unit(token) {
            out.unit.get_or_insert_with(|| unit_of(token));
        } else if is_price_amount(&token.raw)
            || (is_number_word(&token.folded) && (prev_unit || next_unit))
        {
            continue;
        } else {
            kept.push(token.raw.clone());
        }
    }
    kept.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("testdata/clean_cases.tsv");
    const QTY: &str = include_str!("testdata/clean_qty.tsv");

    fn rows(text: &str) -> Vec<Vec<&str>> {
        let lines = text.lines().filter(|l| !l.starts_with(char::from(35u8)));
        lines.map(|l| l.split(char::from(9u8)).collect()).collect()
    }

    #[test]
    fn name_cases_hold() {
        rows(CASES).iter().for_each(|row| {
            let (input, want) = (row.first().unwrap(), row.get(1).unwrap());
            assert_eq!((input, clean_name(input)), (input, want.to_string()));
        });
    }

    #[test]
    fn quantity_and_unit_come_back_separately() {
        rows(QTY).iter().for_each(|row| {
            let input = row.first().unwrap();
            let cleaned = clean_phrase(input);
            let qty: Option<f64> = row.get(2).and_then(|q| q.parse().ok());
            let unit = row.get(3).filter(|u| !u.is_empty()).map(|u| u.to_string());
            assert_eq!(
                (input, cleaned.name),
                (input, row.get(1).unwrap().to_string())
            );
            assert_eq!((input, cleaned.quantity), (input, qty));
            assert_eq!((input, cleaned.unit), (input, unit));
        });
    }
}
