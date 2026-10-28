//! `POST /v1/voice/utterances/{id}/outcome`: idempotent, last write wins. Alias learning runs
//! once per utterance (the first confirmed or edited outcome), so retries never double count.
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Actor, data::pool},
};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Confirmed,
    Edited,
    Abandoned,
}
impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Edited => "edited",
            Self::Abandoned => "abandoned",
        }
    }
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Listening,
    Draft,
    Pay,
}
impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Listening => "listening",
            Self::Draft => "draft",
            Self::Pay => "pay",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Correction {
    pub line_id: Uuid,
    pub chosen_product_id: Option<Uuid>,
    pub quantity: Option<i32>,
    pub unit_price: Option<i64>,
    pub removed: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutcomeRequest {
    pub outcome: Outcome,
    pub sale_id: Option<Uuid>,
    pub corrections: Option<Vec<Correction>>,
    pub stage: Option<Stage>,
}

fn db(error: sqlx::Error) -> ApiError {
    crate::error::log_sqlx_error!(error, &error, "voice outcome query failed");
    ApiError::internal()
}

pub async fn record(
    state: &AppState,
    actor: &Actor,
    id: Uuid,
    body: OutcomeRequest,
) -> ApiResult<StatusCode> {
    let corrections = body.corrections.clone().unwrap_or_default();
    if corrections.len() > 50
        || corrections.iter().any(|c| {
            c.quantity.is_some_and(|q| !(1..=999).contains(&q))
                || c.unit_price.is_some_and(|p| p < 0)
        })
    {
        return Err(ApiError::validation_failed("invalid corrections"));
    }
    let mut tx = pool(state)?.begin().await.map_err(db)?;
    let row: Option<(Option<Value>, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        "SELECT draft, learned_at FROM voice_utterances WHERE id=$1 AND store_id=$2 AND member=$3 FOR UPDATE",
    )
    .bind(id)
    .bind(actor.store_id)
    .bind(actor.member_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let (draft, learned_at) = row.ok_or_else(ApiError::not_found)?;
    sqlx::query(
        "UPDATE voice_utterances SET outcome=$2, stage=$3, sale_id=$4, corrections=$5, outcome_at=now() WHERE id=$1",
    )
    .bind(id)
    .bind(body.outcome.as_str())
    .bind(body.stage.map(Stage::as_str))
    .bind(body.sale_id)
    .bind(corrections_json(&corrections))
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if body.outcome != Outcome::Abandoned
        && learned_at.is_none()
        && let Some(draft) = draft
    {
        learn(&mut tx, actor.store_id, &draft, &corrections).await?;
        sqlx::query("UPDATE voice_utterances SET learned_at=now() WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT)
}

fn corrections_json(corrections: &[Correction]) -> Value {
    Value::Array(
        corrections
            .iter()
            .map(|c| {
                serde_json::json!({
                    "line_id": c.line_id, "chosen_product_id": c.chosen_product_id,
                    "quantity": c.quantity, "unit_price": c.unit_price, "removed": c.removed,
                })
            })
            .collect(),
    )
}

/// A product choice for a phrase: `Immediate` aliases apply at once (hits 2), `Counted` ones
/// need a second agreeing correction.
#[derive(Debug, PartialEq, Eq)]
pub enum Learning {
    Immediate(Uuid),
    Counted(Uuid),
}

/// Pure decision for one draft line (see voice.md "Catalog match"): the seller choosing among
/// ambiguous candidates, or accepting the preselected one, teaches the phrase at once; any
/// other correction counts once toward two.
pub fn learning_for(line: &Value, correction: Option<&Correction>) -> Option<Learning> {
    if correction.is_some_and(|c| c.removed == Some(true)) {
        return None;
    }
    let status = line["status"].as_str().unwrap_or_default();
    let candidates: Vec<Uuid> = line["candidates"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| c["id"].as_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    let preselected: Option<Uuid> = line["product"]["id"].as_str().and_then(|s| s.parse().ok());
    match correction.and_then(|c| c.chosen_product_id) {
        Some(chosen) if status == "ambiguous" && candidates.contains(&chosen) => {
            Some(Learning::Immediate(chosen))
        }
        Some(chosen) => Some(Learning::Counted(chosen)),
        None if status == "ambiguous" => preselected.map(Learning::Immediate),
        None => None,
    }
}

async fn learn(
    tx: &mut Transaction<'_, Postgres>,
    store: Uuid,
    draft: &Value,
    corrections: &[Correction],
) -> ApiResult<()> {
    let Some(lines) = draft["lines"].as_array() else {
        return Ok(());
    };
    for line in lines {
        let Some(phrase) = line["phrase"].as_str().filter(|p| !p.is_empty()) else {
            continue;
        };
        let line_id: Option<Uuid> = line["id"].as_str().and_then(|s| s.parse().ok());
        let correction = corrections.iter().find(|c| Some(c.line_id) == line_id);
        let Some(learning) = learning_for(line, correction) else {
            continue;
        };
        let (product, immediate) = match learning {
            Learning::Immediate(p) => (p, true),
            Learning::Counted(p) => (p, false),
        };
        // Same product agrees (hits grow); another product restarts the count.
        sqlx::query(
            "INSERT INTO voice_aliases(store_id, phrase, product_id, hits)
             SELECT $1, $2, p.id, CASE WHEN $4 THEN 2 ELSE 1 END
             FROM products p WHERE p.id=$3 AND p.store_id=$1 AND NOT p.archived
             ON CONFLICT (store_id, phrase) DO UPDATE SET
                hits = CASE
                    WHEN voice_aliases.product_id = EXCLUDED.product_id THEN
                        CASE WHEN $4 THEN greatest(voice_aliases.hits, 2) ELSE voice_aliases.hits + 1 END
                    ELSE EXCLUDED.hits END,
                product_id = EXCLUDED.product_id,
                updated_at = now()",
        )
        .bind(store)
        .bind(phrase)
        .bind(product)
        .bind(immediate)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn correction(line: Uuid, chosen: Option<Uuid>, removed: bool) -> Correction {
        Correction {
            line_id: line,
            chosen_product_id: chosen,
            quantity: None,
            unit_price: None,
            removed: removed.then_some(true),
        }
    }

    #[test]
    fn ambiguous_pick_learns_at_once() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let line_id = Uuid::new_v4();
        let line = json!({"id": line_id, "status": "ambiguous", "product": {"id": a}, "candidates": [{"id": a}, {"id": b}]});
        assert_eq!(
            learning_for(&line, Some(&correction(line_id, Some(b), false))),
            Some(Learning::Immediate(b))
        );
        // Accepting the preselected candidate also teaches.
        assert_eq!(learning_for(&line, None), Some(Learning::Immediate(a)));
        // A removed line teaches nothing.
        assert_eq!(
            learning_for(&line, Some(&correction(line_id, None, true))),
            None
        );
    }

    #[test]
    fn other_corrections_count_once_toward_two() {
        let (a, other) = (Uuid::new_v4(), Uuid::new_v4());
        let line_id = Uuid::new_v4();
        let matched = json!({"id": line_id, "status": "matched", "product": {"id": a}});
        assert_eq!(
            learning_for(&matched, Some(&correction(line_id, Some(other), false))),
            Some(Learning::Counted(other))
        );
        assert_eq!(learning_for(&matched, None), None);
        let unknown = json!({"id": line_id, "status": "unknown"});
        assert_eq!(
            learning_for(&unknown, Some(&correction(line_id, Some(other), false))),
            Some(Learning::Counted(other))
        );
        // A choice outside the ambiguous candidates is an ordinary correction.
        let ambiguous = json!({"id": line_id, "status": "ambiguous", "product": {"id": a}, "candidates": [{"id": a}]});
        assert_eq!(
            learning_for(&ambiguous, Some(&correction(line_id, Some(other), false))),
            Some(Learning::Counted(other))
        );
    }
}
