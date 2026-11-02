//! Product enrollment prompt, schema and deterministic transcript fallback.
use super::{model::VoiceParse, rules};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROMPT: &str = "Chép đúng lời nói vào transcript. Trích xuất tên sản phẩm, giá bằng đồng và đơn vị được nói để điền biểu mẫu sản phẩm mới. Không tự thêm giá hay đơn vị. Trả JSON theo schema; không có lời nói thì transcript rỗng. Confidence từ 0 đến 1.";
pub fn schema() -> Value {
    json!({"type":"object", "additionalProperties":false,
      "required":["transcript","name","price","unit","confidence"],
      "properties":{"transcript":{"type":"string"},"name":{"type":"string"},
      "price":{"type":["integer","null"]},"unit":{"type":["string","null"]},"confidence":{"type":"number"}}})
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductDraft {
    pub name: String,
    pub price: Option<i64>,
    pub unit: Option<String>,
}

fn unit_word(word: &str) -> Option<&'static str> {
    match super::text::fold(word).as_str() {
        "chai" => Some("chai"),
        "goi" => Some("gói"),
        "lon" => Some("lon"),
        "hop" => Some("hộp"),
        "cai" => Some("cái"),
        "kg" | "ky" => Some("kg"),
        _ => None,
    }
}

pub fn fallback(transcript: &str) -> ProductDraft {
    let mut words: Vec<&str> = transcript.split_whitespace().collect();
    let mut unit = None;
    if let Some(last) = words.last().copied() {
        let cleaned = last.trim_matches(|c: char| !c.is_alphanumeric());
        let canonical = unit_word(cleaned);
        if let Some(u) = canonical
            && words.len() >= 2
            && matches!(
                super::text::fold(words[words.len() - 2]).as_str(),
                "mot" | "moi" | "1"
            )
        {
            words.pop();
            words.pop();
            unit = Some(u.to_owned());
        }
    }
    let mut split = words.len();
    let mut price = None;
    for index in 1..words.len() {
        let phrase = words[index..].join(" ");
        if let Some(value) = rules::parse_spoken_amount(&phrase)
            .and_then(|a| rules::amount_in_dong(a, None))
            .filter(|p| rules::price_in_range(*p))
        {
            split = index;
            price = Some(value);
            break;
        }
    }
    if unit.is_none() {
        unit = words[..split]
            .iter()
            .find_map(|word| unit_word(word).map(str::to_owned));
    }
    ProductDraft {
        name: words[..split]
            .join(" ")
            .trim_matches(|c: char| c.is_whitespace() || c == ',' || c == '.')
            .to_owned(),
        price,
        unit,
    }
}

pub fn draft(parse: &VoiceParse) -> ProductDraft {
    let fallback = fallback(&parse.transcript);
    ProductDraft {
        name: if parse.name.trim().is_empty() {
            fallback.name.clone()
        } else {
            parse.name.trim().to_owned()
        },
        price: fallback
            .price
            .or(parse.price.filter(|price| rules::price_in_range(*price))),
        unit: fallback.unit.or_else(|| {
            parse
                .unit
                .as_deref()
                .map(str::trim)
                .filter(|unit| !unit.is_empty())
                .map(str::to_owned)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{draft, fallback};
    use crate::voice::model::VoiceParse;

    #[test]
    fn draft_uses_agreeing_rules_and_model_values() {
        let parse = VoiceParse {
            transcript: "nước năm nghìn một chai".into(),
            price: Some(5000),
            unit: Some("chai".into()),
            ..VoiceParse::default()
        };
        let result = draft(&parse);
        assert_eq!(result.price, Some(5000));
        assert_eq!(result.unit.as_deref(), Some("chai"));
    }

    #[test]
    fn draft_prefers_rules_when_model_disagrees() {
        let parse = VoiceParse {
            transcript: "nước năm nghìn một chai".into(),
            price: Some(6000),
            unit: Some("lon".into()),
            ..VoiceParse::default()
        };
        let result = draft(&parse);
        assert_eq!(result.price, Some(5000));
        assert_eq!(result.unit.as_deref(), Some("chai"));
    }

    #[test]
    fn draft_uses_valid_model_price_when_rules_find_none() {
        let parse = VoiceParse {
            transcript: "nước".into(),
            price: Some(8000),
            ..VoiceParse::default()
        };
        assert_eq!(draft(&parse).price, Some(8000));
    }

    #[test]
    fn draft_rejects_out_of_range_model_price() {
        for price in [0, 499, 50_000_001] {
            let parse = VoiceParse {
                transcript: "nước".into(),
                price: Some(price),
                ..VoiceParse::default()
            };
            assert_eq!(draft(&parse).price, None);
        }
    }

    #[test]
    fn draft_uses_trimmed_model_unit_when_rules_find_none() {
        let parse = VoiceParse {
            transcript: "nước".into(),
            unit: Some("  chai  ".into()),
            ..VoiceParse::default()
        };
        assert_eq!(draft(&parse).unit.as_deref(), Some("chai"));
        let blank = VoiceParse {
            unit: Some("  ".into()),
            ..parse
        };
        assert_eq!(draft(&blank).unit, None);
    }

    #[test]
    fn vietnamese_product_phrases() {
        let cases = [
            (
                "Mì Hảo Hảo tôm chua cay năm nghìn",
                "Mì Hảo Hảo tôm chua cay",
                Some(5000),
                None,
            ),
            ("mì Hảo Hảo 5k", "mì Hảo Hảo", Some(5000), None),
            ("sữa mười hai nghìn rưỡi", "sữa", Some(12500), None),
            ("cà phê hai mươi lăm ngàn", "cà phê", Some(25000), None),
            (
                "nước suối Lavie 500ml, tám nghìn rưỡi một chai",
                "nước suối Lavie 500ml",
                Some(8500),
                Some("chai"),
            ),
            ("bánh 10k một gói", "bánh", Some(10000), Some("gói")),
            ("bia 20k một lon", "bia", Some(20000), Some("lon")),
            ("sữa 30k một hộp", "sữa", Some(30000), Some("hộp")),
            ("bút 4k một cái", "bút", Some(4000), Some("cái")),
            ("gạo 25k một kg", "gạo", Some(25000), Some("kg")),
            ("dầu ăn một triệu rưỡi", "dầu ăn", Some(1500000), None),
            ("kẹo ba nghìn", "kẹo", Some(3000), None),
            ("trà 12k", "trà", Some(12000), None),
            ("nước mắm", "nước mắm", None, None),
            ("sữa 500ml", "sữa 500ml", None, None),
            ("gạo ST25", "gạo ST25", None, None),
        ];
        for (spoken, name, price, unit) in cases {
            let draft = fallback(spoken);
            assert_eq!(
                (draft.name.as_str(), draft.price, draft.unit.as_deref()),
                (name, price, unit),
                "{spoken}"
            );
        }
    }
}
