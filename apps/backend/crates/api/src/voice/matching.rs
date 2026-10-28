//! Catalog and customer matching for spoken names (voice.md "Catalog match").
//!
//! Order: learned alias, then accent-insensitive trigram similarity blended with token overlap.
//! Scoring and banding are pure functions; the SQL only fetches the best eight trigram hits.
use super::text::fold;
use crate::debts;
use serde::Deserialize;
use sqlx::{PgPool, types::Json};
use std::collections::HashSet;
use uuid::Uuid;

pub const MATCHED_MIN: f32 = 0.80;
pub const AMBIGUOUS_MIN: f32 = 0.50;
/// Two candidates this close at the top are a coin flip, not a match.
const TIE_MARGIN: f32 = 0.05;
pub const MAX_CANDIDATES: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct Scored {
    pub id: Uuid,
    pub name: String,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Band {
    Matched(Scored),
    /// Up to three candidates, best first (the best is preselected).
    Ambiguous(Vec<Scored>),
    Unknown,
}

fn has_digit(token: &str) -> bool {
    token.chars().any(|c| c.is_ascii_digit())
}

/// Blend trigram similarity (`sim`), word similarity (`word`: the query inside the name) and
/// token overlap. Size tokens ("330ml") count extra when present and penalize when absent.
pub fn product_score(query: &str, name: &str, sim: f32, word: f32) -> f32 {
    let q = fold(query);
    let n = fold(name);
    if q.is_empty() || n.is_empty() {
        return 0.0;
    }
    if q == n {
        return 1.0;
    }
    let name_tokens: HashSet<&str> = n.split(' ').collect();
    let query_tokens: Vec<&str> = q.split(' ').collect();
    let hits = query_tokens
        .iter()
        .filter(|t| name_tokens.contains(**t))
        .count();
    let coverage = hits as f32 / query_tokens.len() as f32;
    let base = 0.75 * word.clamp(0.0, 1.0) + 0.25 * sim.clamp(0.0, 1.0);
    let mut score = 0.7 * base + 0.3 * coverage;
    for token in query_tokens.iter().filter(|t| has_digit(t)) {
        if name_tokens.contains(token) {
            score += 0.05;
        } else {
            score *= 0.8;
        }
    }
    score.clamp(0.0, 1.0)
}

/// Customers match mostly on the name inside the stored name ("Lan" in "Chị Lan").
pub fn customer_score(query: &str, name: &str, sim: f32, word: f32) -> f32 {
    let q = fold(query);
    let n = fold(name);
    if q.is_empty() || n.is_empty() {
        return 0.0;
    }
    if q == n {
        return 1.0;
    }
    (0.6 * word.clamp(0.0, 1.0) + 0.4 * sim.clamp(0.0, 1.0)).min(0.99)
}

/// Strip a leading honorific ("chị Lan" -> "lan") unless nothing else is left.
pub fn without_honorific(name: &str) -> String {
    const HONORIFICS: &[&str] = &[
        "chi", "anh", "co", "chu", "bac", "em", "ong", "ba", "di", "cau", "mo", "thim", "me",
    ];
    let folded = fold(name);
    let mut tokens: Vec<&str> = folded.split(' ').filter(|t| !t.is_empty()).collect();
    if tokens.len() > 1 && HONORIFICS.contains(&tokens[0]) {
        tokens.remove(0);
    }
    tokens.join(" ")
}

/// Apply the bands to scored candidates (any order).
pub fn classify(mut scored: Vec<Scored>) -> Band {
    scored.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
    let Some(top) = scored.first().cloned() else {
        return Band::Unknown;
    };
    if top.score < AMBIGUOUS_MIN {
        return Band::Unknown;
    }
    let near_tie = top.score < 1.0
        && scored
            .get(1)
            .is_some_and(|next| next.score >= MATCHED_MIN && top.score - next.score < TIE_MARGIN);
    if top.score >= MATCHED_MIN && !near_tie {
        return Band::Matched(top);
    }
    Band::Ambiguous(
        scored
            .into_iter()
            .filter(|s| s.score >= AMBIGUOUS_MIN)
            .take(MAX_CANDIDATES)
            .collect(),
    )
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UnitInfo {
    pub id: Uuid,
    pub name: String,
    pub quantity_in_base: i32,
    pub price: i64,
    pub barcode: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProductInfo {
    pub id: Uuid,
    pub name: Option<String>,
    pub price: i64,
    pub base_unit: String,
    pub units: Json<Vec<UnitInfo>>,
    pub image_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum UnitChoice<'a> {
    Base,
    Unit(&'a UnitInfo),
    /// A weight was spoken ("nửa ký") but the product is not sold by that unit.
    WeightMismatch,
}

/// The spoken unit picks the product unit when it exists ("thùng" versus "lon"), else the base.
pub fn resolve_unit<'a>(product: &'a ProductInfo, spoken: Option<&str>) -> UnitChoice<'a> {
    let Some(spoken) = spoken.map(fold).filter(|s| !s.is_empty()) else {
        return UnitChoice::Base;
    };
    if let Some(unit) = product.units.0.iter().find(|u| fold(&u.name) == spoken) {
        return UnitChoice::Unit(unit);
    }
    if fold(&product.base_unit) == spoken {
        return UnitChoice::Base;
    }
    if let Some(weight) = super::rules::weight_unit(&spoken) {
        // "hai ký" of a product whose base unit is kg is two base units; any other weight
        // cannot be expressed as an integer quantity.
        return if super::rules::weight_unit(&product.base_unit) == Some(weight) {
            UnitChoice::Base
        } else {
            UnitChoice::WeightMismatch
        };
    }
    UnitChoice::Base
}

pub fn alias_phrase(query: &str) -> String {
    fold(query)
}

/// Learned aliases (two agreeing corrections, or one confirmed ambiguous pick) for `phrases`.
pub async fn alias_lookup(
    pool: &PgPool,
    store: Uuid,
    phrases: &[String],
) -> sqlx::Result<std::collections::HashMap<String, Uuid>> {
    if phrases.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT a.phrase, a.product_id FROM voice_aliases a
         JOIN products p ON p.id=a.product_id AND p.store_id=a.store_id AND NOT p.archived
         WHERE a.store_id=$1 AND a.phrase=ANY($2) AND a.hits>=2",
    )
    .bind(store)
    .bind(phrases)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Word-similarity floor of the `<%` prefilter. Below it a name cannot reach the ambiguous
/// band (0.50) after blending, and above it the GIN trigram index applies.
const PREFILTER_THRESHOLD: &str = "0.4";

/// Best eight trigram hits per query, scored and banded. `queries[i]` gives `result[i]`.
pub async fn search_products(
    pool: &PgPool,
    store: Uuid,
    queries: &[String],
) -> sqlx::Result<Vec<Band>> {
    if queries.is_empty() {
        return Ok(vec![]);
    }
    let folded: Vec<String> = queries.iter().map(|q| fold(q)).collect();
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)")
        .bind(PREFILTER_THRESHOLD)
        .execute(&mut *tx)
        .await?;
    let rows: Vec<(i64, Uuid, String, f32, f32)> = sqlx::query_as(
        "SELECT (input.ord - 1)::bigint, c.id, c.name, c.sim, c.word
         FROM unnest($2::text[]) WITH ORDINALITY AS input(q, ord)
         CROSS JOIN LATERAL (
            SELECT t.id, t.name, t.sim, t.word FROM (
                SELECT p.id, p.name,
                       similarity(immutable_unaccent(lower(p.name)), input.q) AS sim,
                       word_similarity(input.q, immutable_unaccent(lower(p.name))) AS word
                FROM products p
                WHERE p.store_id=$1 AND NOT p.archived AND p.name IS NOT NULL
                  AND input.q <% immutable_unaccent(lower(p.name))
            ) t
            ORDER BY greatest(t.sim, t.word) DESC, t.id
            LIMIT 8
         ) c",
    )
    .bind(store)
    .bind(&folded)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut per_query: Vec<Vec<Scored>> = vec![vec![]; queries.len()];
    for (index, id, name, sim, word) in rows {
        let Some(slot) = usize::try_from(index)
            .ok()
            .and_then(|i| per_query.get_mut(i))
        else {
            continue;
        };
        let score = product_score(&folded[index as usize], &name, sim, word);
        slot.push(Scored { id, name, score });
    }
    Ok(per_query.into_iter().map(classify).collect())
}

pub async fn load_products(
    pool: &PgPool,
    store: Uuid,
    ids: &[Uuid],
) -> sqlx::Result<Vec<ProductInfo>> {
    sqlx::query_as(
        "SELECT p.id, p.name, p.price, p.base_unit,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'quantity_in_base',u.quantity_in_base,'price',u.price,'barcode',u.barcode) ORDER BY u.id)
                          FROM product_units u WHERE u.product_id=p.id), '[]'::jsonb) AS units,
                (SELECT im.object_key FROM product_images pi JOIN images im ON im.id=pi.image_id
                 WHERE pi.product_id=p.id ORDER BY pi.position LIMIT 1) AS image_key
         FROM products p WHERE p.store_id=$1 AND p.id=ANY($2)",
    )
    .bind(store)
    .bind(ids)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone)]
pub enum CustomerBand {
    Matched(Uuid),
    Candidates(Vec<Uuid>),
    None,
}

/// Credit customer: unaccent + trigram on non-archived customers, honorific stripped.
pub async fn match_customer(
    pool: &PgPool,
    store: Uuid,
    spoken: &str,
) -> sqlx::Result<CustomerBand> {
    let query = without_honorific(spoken);
    if query.is_empty() {
        return Ok(CustomerBand::None);
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)")
        .bind(PREFILTER_THRESHOLD)
        .execute(&mut *tx)
        .await?;
    let rows: Vec<(Uuid, String, f32, f32)> = sqlx::query_as(
        "SELECT t.id, t.name, t.sim, t.word FROM (
            SELECT c.id, c.name,
                   similarity(immutable_unaccent(lower(c.name)), $2) AS sim,
                   word_similarity($2, immutable_unaccent(lower(c.name))) AS word
            FROM customers c WHERE c.store_id=$1 AND c.archived_at IS NULL
              AND $2 <% immutable_unaccent(lower(c.name))
         ) t ORDER BY greatest(t.sim, t.word) DESC, t.id LIMIT 8",
    )
    .bind(store)
    .bind(&query)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let scored = rows
        .into_iter()
        .map(|(id, name, sim, word)| Scored {
            score: customer_score(&query, &name, sim, word),
            id,
            name,
        })
        .collect();
    Ok(match classify(scored) {
        Band::Matched(s) => CustomerBand::Matched(s.id),
        Band::Ambiguous(list) => CustomerBand::Candidates(list.into_iter().map(|s| s.id).collect()),
        Band::Unknown => CustomerBand::None,
    })
}

pub async fn load_customers(
    pool: &PgPool,
    store: Uuid,
    ids: &[Uuid],
) -> crate::ApiResult<Vec<(Uuid, serde_json::Value)>> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| crate::ApiError::unavailable())?;
    debts::load_customers(&mut conn, store, ids).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, score: f32) -> Scored {
        Scored {
            id: Uuid::new_v4(),
            name: name.into(),
            score,
        }
    }

    #[test]
    fn exact_name_scores_one() {
        assert_eq!(product_score("Hảo Hảo", "hao hao", 1.0, 1.0), 1.0);
    }

    #[test]
    fn short_spoken_name_inside_long_catalog_name_is_a_match() {
        let score = product_score("tương ớt", "Tương ớt Chinsu 250ml", 0.45, 1.0);
        assert!(score >= MATCHED_MIN, "{score}");
    }

    #[test]
    fn unrelated_names_are_unknown() {
        let score = product_score("bia tiger", "Nước mắm Nam Ngư", 0.1, 0.15);
        assert!(score < AMBIGUOUS_MIN, "{score}");
    }

    #[test]
    fn size_token_counts_extra_and_missing_size_penalizes() {
        let with = product_score("coca 330ml", "Coca Cola 330ml", 0.5, 0.9);
        let without = product_score("coca 330ml", "Coca Cola 1.5L", 0.5, 0.9);
        assert!(with > without + 0.1, "{with} {without}");
    }

    #[test]
    fn bands() {
        assert!(
            matches!(classify(vec![s("a", 0.95), s("b", 0.6)]), Band::Matched(m) if m.name == "a")
        );
        match classify(vec![
            s("a", 0.7),
            s("b", 0.6),
            s("c", 0.55),
            s("d", 0.52),
            s("e", 0.1),
        ]) {
            Band::Ambiguous(list) => {
                assert_eq!(
                    list.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
                    ["a", "b", "c"]
                );
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(classify(vec![s("a", 0.49)]), Band::Unknown);
        assert_eq!(classify(vec![]), Band::Unknown);
        // Boundaries: 0.80 is matched, 0.50 is ambiguous.
        assert!(matches!(classify(vec![s("a", 0.80)]), Band::Matched(_)));
        assert!(matches!(classify(vec![s("a", 0.50)]), Band::Ambiguous(_)));
    }

    #[test]
    fn near_tie_at_the_top_is_ambiguous() {
        match classify(vec![s("chinsu", 0.9), s("cholimex", 0.88)]) {
            Band::Ambiguous(list) => assert_eq!(list.len(), 2),
            other => panic!("{other:?}"),
        }
        // A clear winner is still matched.
        assert!(matches!(
            classify(vec![s("a", 1.0), s("b", 0.99)]),
            Band::Matched(_)
        ));
    }

    #[test]
    fn honorifics() {
        assert_eq!(without_honorific("chị Lan"), "lan");
        assert_eq!(without_honorific("Anh"), "anh");
        assert_eq!(without_honorific("Bà Năm Sài Gòn"), "nam sai gon");
    }

    #[test]
    fn customer_score_exact_and_partial() {
        assert_eq!(customer_score("lan", "Lan", 1.0, 1.0), 1.0);
        let partial = customer_score("lan", "Lan Anh", 0.5, 1.0);
        assert!((0.5..1.0).contains(&partial));
        assert!(customer_score("lan", "Lan", 1.0, 1.0) - partial > TIE_MARGIN);
    }

    fn product(units: Vec<UnitInfo>) -> ProductInfo {
        ProductInfo {
            id: Uuid::new_v4(),
            name: Some("Coca".into()),
            price: 10_000,
            base_unit: "lon".into(),
            units: Json(units),
            image_key: None,
        }
    }
    #[test]
    fn spoken_unit_picks_product_unit() {
        let crate_unit = UnitInfo {
            id: Uuid::new_v4(),
            name: "thùng".into(),
            quantity_in_base: 24,
            price: 220_000,
            barcode: None,
        };
        let p = product(vec![crate_unit.clone()]);
        assert_eq!(
            resolve_unit(&p, Some("Thùng")),
            UnitChoice::Unit(&crate_unit)
        );
        assert_eq!(resolve_unit(&p, Some("lon")), UnitChoice::Base);
        assert_eq!(resolve_unit(&p, Some("cái")), UnitChoice::Base);
        assert_eq!(resolve_unit(&p, None), UnitChoice::Base);
        assert_eq!(resolve_unit(&p, Some("ký")), UnitChoice::WeightMismatch);
        let kg = ProductInfo {
            base_unit: "kg".into(),
            ..product(vec![])
        };
        assert_eq!(resolve_unit(&kg, Some("ký")), UnitChoice::Base);
        assert_eq!(resolve_unit(&kg, Some("kg")), UnitChoice::Base);
        assert_eq!(resolve_unit(&kg, Some("lạng")), UnitChoice::WeightMismatch);
    }
}
