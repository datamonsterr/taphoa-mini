//! Catalog ranking for spoken product names.
//!
//! The spoken name is folded (no diacritics, lowercase) and compared with every product name
//! of the store token by token, so it still finds the product when the seller uses the brand
//! only or the generic name only, changes the word order, drops the diacritics, splits or
//! joins a brand (chin su and Chinsu) or leaves the size out. A generic category such as nuoc
//! ngot names no product, so it gets the products of a known brand list as ambiguous
//! candidates. Scores feed the same bands as before (matching::classify).
use super::{
    matching::{Band, Scored, classify},
    text::fold,
};
use uuid::Uuid;

/// A product name prepared for ranking.
#[derive(Debug, Clone)]
pub struct Entry {
    pub id: Uuid,
    pub name: String,
    tokens: Vec<String>,
}

impl Entry {
    pub fn new(id: Uuid, name: &str) -> Self {
        Self {
            id,
            name: name.to_owned(),
            tokens: words(name),
        }
    }
}

fn words(text: &str) -> Vec<String> {
    let folded = fold(text);
    let parts = folded.split_whitespace();
    parts.map(str::to_owned).collect()
}

fn has_num(token: &str) -> bool {
    token.chars().any(|c| c.is_ascii_digit())
}

/// Short forms sellers say for a name or a brand.
const ABBREVIATIONS: &[(&str, &str)] = &[
    ("nm", "nuoc mam"),
    ("hh", "hao hao"),
    ("cc", "coca cola"),
    ("sg", "saigon"),
];

type Category = (&'static [&'static str], &'static [&'static str]);

/// Generic category phrases and the brand words of products that belong to them.
const CATEGORIES: &[Category] = &[
    (
        &["nuoc ngot", "nuoc giai khat", "nuoc co ga", "do uong co ga"],
        &[
            "coca", "cola", "pepsi", "sprite", "fanta", "7up", "mirinda", "sting", "number",
        ],
    ),
    (
        &["nuoc suoi", "nuoc loc", "nuoc tinh khiet"],
        &["aquafina", "lavie", "dasani", "satori"],
    ),
    (
        &["nuoc tang luc", "tang luc"],
        &["redbull", "sting", "revive", "monster", "warrior", "number"],
    ),
    (
        &["ca phe", "cafe", "coffee"],
        &["g7", "nescafe", "vinacafe", "trung", "highlands"],
    ),
];

/// The folded words of a spoken name, with short forms spelled out.
pub fn query_words(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in words(query) {
        match ABBREVIATIONS.iter().find(|(short, _)| *short == word) {
            Some((_, long)) => out.extend(words(long)),
            None => out.push(word),
        }
    }
    out
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = row.first().copied().unwrap_or(0);
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            let next = (row[j + 1] + 1).min(row[j] + 1).min(diagonal + cost);
            diagonal = row[j + 1];
            row[j + 1] = next;
        }
    }
    row.last().copied().unwrap_or(0)
}

/// How well one spoken word matches one name word, from 0 to 1.
fn token_match(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    if has_num(a) || has_num(b) {
        return 0.0;
    }
    let (la, lb) = (a.chars().count(), b.chars().count());
    if la.min(lb) >= 3 && (a.starts_with(b) || b.starts_with(a)) {
        return 0.7;
    }
    let distance = edit_distance(a, b);
    let longer = la.max(lb);
    if longer >= 5 && distance <= 1 {
        0.85
    } else if longer >= 8 && distance <= 2 {
        0.75
    } else {
        0.0
    }
}

fn best_of(slot: &mut f32, value: f32) {
    if value > *slot {
        *slot = value;
    }
}

/// Match every spoken word against the name words, and against two name words joined (chin su
/// against Chinsu) or two spoken words joined (the other way). Returns the best match per
/// spoken word and which name words took part.
fn cover(query: &[&String], entry: &[&String]) -> (Vec<f32>, Vec<bool>) {
    let mut covered = vec![0.0_f32; query.len()];
    let mut used = vec![false; entry.len()];
    for (i, q) in query.iter().enumerate() {
        for (j, n) in entry.iter().enumerate() {
            let m = token_match(q, n);
            best_of(&mut covered[i], m);
            used[j] |= m >= 0.7;
            if let Some(next) = entry.get(j + 1) {
                let joined = [n.as_str(), next.as_str()].concat();
                let m = token_match(q, &joined);
                if m >= 0.85 {
                    best_of(&mut covered[i], m);
                    used[j] = true;
                    used[j + 1] = true;
                }
            }
            if let Some(next) = query.get(i + 1) {
                let joined = [q.as_str(), next.as_str()].concat();
                let m = token_match(&joined, n);
                if m >= 0.85 {
                    best_of(&mut covered[i], m);
                    best_of(&mut covered[i + 1], m);
                    used[j] = true;
                }
            }
        }
    }
    (covered, used)
}

/// Score of one product name for a spoken name, from 0 to 1. Words are weighed by how much
/// of the spoken name is found (so brand only and generic name only both reach the product)
/// and a little by how much of the product name was spoken (so the shorter name wins a tie).
/// A size word helps when it is there and hurts when the product has another size.
pub fn score(query: &[String], entry: &Entry) -> f32 {
    if query.is_empty() || entry.tokens.is_empty() {
        return 0.0;
    }
    if query == entry.tokens.as_slice() {
        return 1.0;
    }
    let sizes: Vec<&String> = query.iter().filter(|t| has_num(t)).collect();
    let mut core: Vec<&String> = query.iter().filter(|t| !has_num(t)).collect();
    let mut name_core: Vec<&String> = entry.tokens.iter().filter(|t| !has_num(t)).collect();
    if core.is_empty() {
        core = query.iter().collect();
        name_core = entry.tokens.iter().collect();
    }
    if name_core.is_empty() {
        name_core = entry.tokens.iter().collect();
    }
    let (covered, used) = cover(&core, &name_core);
    let spoken = covered.iter().sum::<f32>() / covered.len() as f32;
    let heard = used.iter().filter(|u| **u).count() as f32 / name_core.len() as f32;
    let mut score = spoken * (0.8 + 0.2 * heard);
    if !sizes.is_empty() {
        if sizes.iter().any(|s| entry.tokens.contains(s)) {
            score += 0.05;
        } else if entry.tokens.iter().any(|t| has_num(t)) {
            score *= 0.8;
        }
    }
    score.clamp(0.0, 1.0)
}

fn is_brand(generic: Option<&[&str]>, entry: &Entry) -> bool {
    let list = generic.unwrap_or_default();
    entry.tokens.iter().any(|t| list.contains(&t.as_str()))
}

/// Rank the catalog for one spoken name and band the result.
pub fn rank(query: &str, catalog: &[Entry]) -> Band {
    let spoken = query_words(query);
    let generic = category_index(&spoken).map(|i| CATEGORIES[i].1);
    let mut scored = Vec::new();
    for entry in catalog {
        let mut value = score(&spoken, entry);
        if is_brand(generic, entry) {
            value = value.max(GENERIC_SCORE);
        }
        if value > 0.0 {
            scored.push(Scored {
                id: entry.id,
                name: entry.name.clone(),
                score: value,
            });
        }
    }
    classify(scored)
}

/// Score given to a product of a known brand when only its category was spoken.
const GENERIC_SCORE: f32 = 0.6;

fn same_words(key: &str, query: &[String]) -> bool {
    key.split_whitespace().eq(query.iter().map(String::as_str))
}

fn category_index(query: &[String]) -> Option<usize> {
    CATEGORIES
        .iter()
        .position(|c| c.0.iter().any(|k| same_words(k, query)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("testdata/rank_cases.tsv");
    const CATALOG: &str = include_str!("testdata/rank_catalog.txt");

    fn catalog() -> Vec<Entry> {
        let names = CATALOG.lines().filter(|l| !l.is_empty());
        names.map(|n| Entry::new(Uuid::new_v4(), n)).collect()
    }

    fn rows(text: &str) -> Vec<Vec<&str>> {
        let lines = text.lines().filter(|l| !l.starts_with(char::from(35u8)));
        lines.map(|l| l.split(char::from(9u8)).collect()).collect()
    }

    fn names(band: &Band) -> Vec<String> {
        match band {
            Band::Matched(s) => vec![s.name.clone()],
            Band::Ambiguous(list) => list.iter().map(|s| s.name.clone()).collect(),
            Band::Unknown => vec![],
        }
    }

    fn expected(row: &[&str]) -> Vec<String> {
        let list = row.get(2).copied().unwrap_or_default();
        let bar = char::from(124u8);
        list.split(bar)
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// First letter of the band name in the case file: m, a or u.
    fn letter(band: &Band) -> u8 {
        match band {
            Band::Matched(_) => 109,
            Band::Ambiguous(_) => 97,
            Band::Unknown => 117,
        }
    }

    #[test]
    fn golden_cases_resolve_to_the_expected_band_and_products() {
        let catalog = catalog();
        for row in rows(CASES) {
            let query = row.first().copied().unwrap_or_default();
            let kind = row.get(1).copied().unwrap_or_default();
            let want = expected(&row);
            let band = rank(query, &catalog);
            let got = names(&band);
            let letter_want = kind.as_bytes().first().copied().unwrap_or(0);
            assert_eq!((query, letter(&band)), (query, letter_want));
            if letter_want == 109 {
                assert_eq!((query, got.first()), (query, want.first()));
            } else if letter_want == 97 {
                let inside = got.iter().all(|n| want.contains(n));
                assert_eq!((query, inside), (query, true));
                assert_eq!((query, got.len()), (query, want.len().min(3)));
            }
        }
    }
}
