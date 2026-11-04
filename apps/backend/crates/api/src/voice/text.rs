//! Accent-insensitive normalization shared by the rules, the catalog match and aliases.
use unicode_normalization::UnicodeNormalization;

/// Lowercase, strip diacritics (`đ` becomes `d`), turn punctuation into spaces and collapse
/// runs of spaces. "Hảo-Hảo 330ml!" becomes "hao hao 330ml".
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = true;
    for c in text.nfd() {
        if ('\u{0300}'..='\u{036f}').contains(&c) {
            continue;
        }
        let c = match c {
            'đ' | 'Đ' => 'd',
            c => c,
        };
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folds_accents_case_and_punctuation() {
        assert_eq!(fold("Hảo-Hảo 330ml!"), "hao hao 330ml");
        assert_eq!(fold("  Đường  Biên Hòa "), "duong bien hoa");
        assert_eq!(fold(""), "");
    }
}
