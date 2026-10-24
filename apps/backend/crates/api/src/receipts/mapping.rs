use super::LineCandidate;
use crate::decisions::{DecisionClient, DecisionRequest};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CatalogCandidate {
    pub product_id: Uuid,
    pub name: String,
    pub price: i64,
    pub similarity: f32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MatchCandidate {
    pub product_id: Uuid,
    pub name: String,
    pub probability: f32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MappedLine {
    pub candidate: LineCandidate,
    pub role: String,
    pub product_id: Option<Uuid>,
    pub match_confidence: Option<f32>,
    pub candidates: Vec<MatchCandidate>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MappingOutcome {
    pub lines: Vec<MappedLine>,
    pub parser: &'static str,
    pub model: Option<String>,
    pub decisions_ms: u64,
}

/// Candidate prefilter for migration 0006's GIN trigram index. `$1` is the store UUID,
/// `$2` the parsed product name. `%` enables the index; explicit similarity ordering
/// (then UUID for ties) does not depend on `set_limit`. Products use `archived`, not
/// a `deleted_at` column. The session trigram threshold controls candidate inclusion.
pub const CANDIDATE_PREFILTER_SQL: &str = r#"
SELECT id AS product_id, name, price,
       similarity(immutable_unaccent(lower(name)), immutable_unaccent(lower($2))) AS similarity
FROM products
WHERE store_id = $1 AND NOT archived
  AND immutable_unaccent(lower(name)) % immutable_unaccent(lower($2))
ORDER BY similarity DESC, id
LIMIT 8
"#;

/// Build one batch request, with stable short catalog IDs scoped to each line.
/// `all_lines` provides up to 60 candidate raw texts as context; `line` keeps all
/// parsed candidates, so every role/match question has its original OCR fields.
pub fn build_request(
    model: &str,
    candidates: &[LineCandidate],
    catalog: &[Vec<CatalogCandidate>],
) -> DecisionRequest {
    use crate::decisions::Question;
    use std::collections::BTreeMap;
    let mut questions = BTreeMap::new();
    for (i, _) in candidates.iter().enumerate() {
        questions.insert(
            format!("role_{i}"),
            Question::Choice {
                instructions: format!("Role of receipt line {i} in state.line"),
                criteria: [
                    ("item", "Product being purchased"),
                    ("total", "Total, payment, tax or discount"),
                    ("header", "Receipt heading or column names"),
                    ("other", "Any other non-item text"),
                ]
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
            },
        );
        let mut criteria: BTreeMap<_, _> = products(catalog, i)
            .iter()
            .enumerate()
            .map(|(j, p)| (format!("p{j}"), format!("{} — {}đ", p.name, p.price)))
            .collect();
        criteria.insert("none".into(), "No product matches".into());
        questions.insert(
            format!("match_{i}"),
            Question::Choice {
                instructions: format!("Which catalog product is receipt line {i} in state.line?"),
                criteria,
            },
        );
    }
    DecisionRequest {
        model: model.into(),
        state: serde_json::json!({"line":candidates,"all_lines":candidates.iter().take(60).map(|line| &line.raw_text).collect::<Vec<_>>()}),
        questions,
    }
}

fn products(catalog: &[Vec<CatalogCandidate>], i: usize) -> &[CatalogCandidate] {
    let list = catalog.get(i).map(Vec::as_slice).unwrap_or_default();
    &list[..list.len().min(8)]
}
fn probability(value: f32) -> f32 {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        value
    } else {
        0.0
    }
}

pub async fn map_lines(
    client: Option<&dyn DecisionClient>,
    candidates: &[LineCandidate],
    catalog: &[Vec<CatalogCandidate>],
) -> MappingOutcome {
    use crate::decisions::Answer;
    let start = std::time::Instant::now();
    let response = if let Some(client) = client {
        if candidates.is_empty() {
            None
        } else {
            client
                .decide(&build_request(client.model(), candidates, catalog))
                .await
                .ok()
        }
    } else {
        None
    };
    let decisions_ms = if client.is_some() && !candidates.is_empty() {
        u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
    } else {
        0
    };
    let mut lines = Vec::new();
    for (i, candidate) in candidates.iter().enumerate() {
        let products = products(catalog, i);
        let (role, product_id, match_confidence, alternatives) = if let Some(response) = &response {
            let role = match response.answers.get(&format!("role_{i}")) {
                Some(Answer::Choice {
                    choice: Some(role), ..
                }) => role.as_str(),
                _ => "other",
            };
            let answer = response.answers.get(&format!("match_{i}"));
            let alternatives: Vec<_> = products
                .iter()
                .enumerate()
                .map(|(j, p)| {
                    let score = match answer {
                        Some(Answer::Choice { probabilities, .. }) => {
                            probabilities.get(&format!("p{j}")).copied().unwrap_or(0.0)
                        }
                        _ => 0.0,
                    };
                    MatchCandidate {
                        product_id: p.product_id,
                        name: p.name.clone(),
                        probability: probability(score),
                    }
                })
                .collect();
            let matched = match answer {
                Some(Answer::Choice {
                    choice: Some(choice),
                    ..
                }) => alternatives
                    .iter()
                    .enumerate()
                    .find(|(j, p)| choice == &format!("p{j}") && p.probability >= 0.5)
                    .map(|(_, p)| p),
                _ => None,
            };
            (
                role,
                matched.map(|p| p.product_id),
                matched.map(|p| p.probability),
                alternatives,
            )
        } else {
            let role = super::parse::keyword_role(&candidate.raw_text);
            let matched = products
                .first()
                .filter(|p| p.similarity.is_finite() && (0.6..=1.0).contains(&p.similarity));
            (
                role,
                matched.map(|p| p.product_id),
                matched.map(|p| p.similarity),
                products
                    .iter()
                    .map(|p| MatchCandidate {
                        product_id: p.product_id,
                        name: p.name.clone(),
                        probability: probability(p.similarity),
                    })
                    .collect(),
            )
        };
        if role == "item" {
            lines.push(MappedLine {
                candidate: candidate.clone(),
                role: role.into(),
                product_id,
                match_confidence,
                candidates: alternatives,
            });
        }
    }
    MappingOutcome {
        lines,
        parser: if response.is_some() {
            "decisions"
        } else {
            "fallback"
        },
        model: client.map(|client| client.model().into()),
        decisions_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decisions::{DecisionError, FakeDecisions};
    use serde_json::json;
    fn line(text: &str) -> LineCandidate {
        LineCandidate {
            position: 0,
            raw_text: text.into(),
            product_name: text.into(),
            quantity: 24,
            cost: 204000,
            unit_price: Some(8500),
        }
    }
    fn catalog() -> Vec<CatalogCandidate> {
        vec![
            CatalogCandidate {
                product_id: Uuid::from_u128(1),
                name: "Coca-Cola lon 330ml".into(),
                price: 8500,
                similarity: 0.8,
            },
            CatalogCandidate {
                product_id: Uuid::from_u128(2),
                name: "Pepsi".into(),
                price: 9000,
                similarity: 0.5,
            },
        ]
    }
    #[test]
    fn request_json_snapshot() {
        let l = line("Coca-Cola lon 330ml");
        let req = build_request("custom/model", std::slice::from_ref(&l), &[catalog()]);
        assert_eq!(
            serde_json::to_value(req).unwrap(),
            json!({
                "model":"custom/model",
                "state":{"line":[l],"all_lines":["Coca-Cola lon 330ml"]},
                "questions":{
                    "role_0":{"type":"choice","instructions":"Role of receipt line 0 in state.line","criteria":{"item":"Product being purchased","total":"Total, payment, tax or discount","header":"Receipt heading or column names","other":"Any other non-item text"}},
                    "match_0":{"type":"choice","instructions":"Which catalog product is receipt line 0 in state.line?","criteria":{"p0":"Coca-Cola lon 330ml — 8500đ","p1":"Pepsi — 9000đ","none":"No product matches"}}
                }
            })
        );
    }
    #[test]
    fn request_limits_catalog_and_context() {
        let lines = vec![line("name"); 70];
        let catalog = vec![(0..8).flat_map(|_| catalog()).collect::<Vec<_>>(); 70];
        let request = build_request("model", &lines, &catalog);
        assert_eq!(request.state["all_lines"].as_array().unwrap().len(), 60);
        let crate::decisions::Question::Choice { criteria, .. } = &request.questions["match_0"];
        assert_eq!(criteria.len(), 9);
        assert!(!criteria.contains_key("p8"));
        assert_eq!(request.questions.len(), 140);
    }
    #[tokio::test]
    async fn roles_and_probability_threshold_and_none() {
        for (choice, probability, matched) in [
            ("p0", 0.5, true),
            ("p0", 0.499, false),
            ("none", 0.99, false),
            ("p99", 1., false),
        ] {
            let client = FakeDecisions::new("model/from-config", [Ok(serde_json::from_value(json!({"answers":{
                "role_0":{"type":"choice","choice":"item"}, "match_0":{"type":"choice","choice":choice,"probabilities":{choice:probability,"p1":0.2},"confidence":0.999},
                "role_1":{"type":"choice","choice":"total"}, "match_1":{"type":"choice","choice":"p0","probabilities":{"p0":1.}}
            }})).unwrap())]);
            let outcome = map_lines(
                Some(&client),
                &[line("Coca"), line("Tổng cộng")],
                &[catalog(), catalog()],
            )
            .await;
            assert_eq!(client.requests().len(), 1);
            assert_eq!(client.requests()[0].model, "model/from-config");
            assert_eq!(outcome.parser, "decisions");
            assert_eq!(outcome.model.as_deref(), Some("model/from-config"));
            assert_eq!(outcome.lines.len(), 1);
            assert_eq!(
                outcome.lines[0].product_id,
                matched.then(|| Uuid::from_u128(1))
            );
            assert_eq!(
                outcome.lines[0].match_confidence,
                matched.then_some(probability)
            );
            assert_eq!(outcome.lines[0].candidates.len(), 2);
        }
    }
    #[tokio::test]
    async fn missing_and_unknown_answers_do_not_invent_matches() {
        for answers in [
            json!({}),
            json!({"role_0":{"type":"future"}}),
            json!({"role_0":{"type":"choice","choice":"item"},"match_0":{"type":"choice","choice":"p0","confidence":1.}}),
        ] {
            let client = FakeDecisions::new(
                "model",
                [Ok(
                    serde_json::from_value(json!({"answers":answers})).unwrap()
                )],
            );
            let outcome = map_lines(Some(&client), &[line("Coca")], &[catalog()]).await;
            assert!(outcome.lines.iter().all(|line| line.product_id.is_none()));
        }
    }
    #[tokio::test]
    async fn fallback_errors_missing_client_and_similarity_threshold() {
        for similarity in [0.599, 0.6] {
            for client_present in [true, false] {
                let client =
                    FakeDecisions::new("configured/model", [Err(DecisionError::Transport)]);
                let mut products = catalog();
                products[0].similarity = similarity;
                let outcome = map_lines(
                    client_present.then_some(&client as &dyn DecisionClient),
                    &[line("Coca"), line("Tổng cộng 204.000"), line("VAT 8.500")],
                    &[products],
                )
                .await;
                assert_eq!(outcome.parser, "fallback");
                assert_eq!(
                    outcome.model.as_deref(),
                    client_present.then_some("configured/model")
                );
                assert_eq!(outcome.lines.len(), 1);
                assert_eq!(
                    outcome.lines[0].product_id,
                    (similarity >= 0.6).then(|| Uuid::from_u128(1))
                );
            }
        }
    }
}
