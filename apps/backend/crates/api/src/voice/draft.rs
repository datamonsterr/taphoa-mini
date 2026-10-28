//! Build the `VoiceSaleDraft` from the model parse: catalog match, unit, rules, customer.
use super::{
    matching::{self, Band, CustomerBand, ProductInfo, UnitChoice, UnitInfo},
    model::VoiceParse,
    rules::{self, PriceDecision, PriceSource, Quantity, SpokenPrice},
    telemetry::Counts,
};
use crate::{ApiError, ApiResult, AppState, auth::Action, auth::Actor};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub const MAX_LINES: usize = 50;

pub struct Draft {
    /// The `sale_draft` of the response.
    pub api: Value,
    /// The same draft plus each line's alias phrase, stored for outcome learning.
    pub stored: Value,
    pub counts: Counts,
}

fn db(error: sqlx::Error) -> ApiError {
    crate::error::log_sqlx_error!(error, &error, "voice draft query failed");
    ApiError::internal()
}

async fn summary(state: &AppState, product: &ProductInfo) -> Value {
    let mut value = json!({
        "id": product.id,
        "name": product.name,
        "price": product.price,
        "base_unit": product.base_unit,
        "units": product.units.0.iter().map(|u| json!({
            "id": u.id, "name": u.name, "quantity_in_base": u.quantity_in_base,
            "price": u.price, "barcode": u.barcode,
        })).collect::<Vec<_>>(),
    });
    if let (Some(storage), Some(key)) = (&state.storage, &product.image_key)
        && let Ok(signed) = storage.presign_get(key, state.image_url_ttl).await
    {
        value["image_url"] = json!(signed.url);
    }
    value
}

/// Payment method of the draft. Credit needs `RecordDebt`; without it the draft is cash and
/// carries no customer, and `POST /v1/sales` still enforces permissions when the seller confirms.
pub fn payment_method(parse: &VoiceParse, can_record_debt: bool) -> &'static str {
    match parse.payment_method.as_deref().map(str::trim) {
        Some("transfer") => "transfer",
        Some("credit") if can_record_debt => "credit",
        _ => "cash",
    }
}

struct Selected<'a> {
    product: &'a ProductInfo,
    unit: Option<&'a UnitInfo>,
}

fn select<'a>(product: &'a ProductInfo, spoken_unit: Option<&str>) -> Option<Selected<'a>> {
    match matching::resolve_unit(product, spoken_unit) {
        UnitChoice::Base => Some(Selected {
            product,
            unit: None,
        }),
        UnitChoice::Unit(unit) => Some(Selected {
            product,
            unit: Some(unit),
        }),
        UnitChoice::WeightMismatch => None,
    }
}

pub async fn build(
    state: &AppState,
    actor: &Actor,
    parse: &VoiceParse,
) -> ApiResult<Option<Draft>> {
    let pool = crate::auth::data::pool(state)?;
    let store = actor.store_id;
    let lines: Vec<_> = parse
        .lines
        .iter()
        .filter(|l| !l.spoken.trim().is_empty() || !l.query.trim().is_empty())
        .take(MAX_LINES)
        .collect();
    if lines.is_empty() {
        return Ok(None);
    }
    let phrases: Vec<String> = lines
        .iter()
        .map(|l| {
            matching::alias_phrase(if l.query.trim().is_empty() {
                &l.spoken
            } else {
                &l.query
            })
        })
        .collect();
    let aliases = matching::alias_lookup(pool, store, &phrases)
        .await
        .map_err(db)?;
    let searched = matching::search_products(pool, store, &phrases)
        .await
        .map_err(db)?;
    let bands: Vec<Band> = searched
        .into_iter()
        .zip(&phrases)
        .map(|(band, phrase)| match aliases.get(phrase) {
            Some(id) => Band::Matched(matching::Scored {
                id: *id,
                name: String::new(),
                score: 1.0,
            }),
            None => band,
        })
        .collect();
    let mut ids: Vec<Uuid> = bands
        .iter()
        .flat_map(|b| match b {
            Band::Matched(s) => vec![s.id],
            Band::Ambiguous(list) => list.iter().map(|s| s.id).collect(),
            Band::Unknown => vec![],
        })
        .collect();
    ids.sort();
    ids.dedup();
    let products: HashMap<Uuid, ProductInfo> = matching::load_products(pool, store, &ids)
        .await
        .map_err(db)?
        .into_iter()
        .map(|p| (p.id, p))
        .collect();

    let mut counts = Counts::default();
    let mut api_lines = Vec::new();
    let mut stored_lines = Vec::new();
    let mut total: i64 = 0;
    for ((line, band), phrase) in lines.iter().zip(&bands).zip(&phrases) {
        let quantity = rules::check_quantity(line.quantity);
        let (count, manual_qty) = match quantity {
            Quantity::Count(n) => (n, false),
            Quantity::Manual => (1, true),
        };
        // A line can only keep its product when the quantity is a valid integer.
        let (status, chosen, candidates): (&str, Option<Selected>, Vec<&ProductInfo>) = match band {
            _ if manual_qty => ("unknown", None, vec![]),
            Band::Matched(s) => match products
                .get(&s.id)
                .and_then(|p| select(p, line.unit.as_deref()))
            {
                Some(sel) => ("matched", Some(sel), vec![]),
                None => ("unknown", None, vec![]),
            },
            Band::Ambiguous(list) => {
                let list: Vec<&ProductInfo> =
                    list.iter().filter_map(|s| products.get(&s.id)).collect();
                match list.first().and_then(|p| select(p, line.unit.as_deref())) {
                    Some(sel) => ("ambiguous", Some(sel), list),
                    None => ("unknown", None, vec![]),
                }
            }
            Band::Unknown => ("unknown", None, vec![]),
        };
        let catalog_price = chosen
            .as_ref()
            .map(|sel| sel.unit.map_or(sel.product.price, |u| u.price));
        let decision: PriceDecision = rules::decide_price(
            SpokenPrice {
                words: line.price_spoken.as_deref(),
                model_value: line.unit_price,
            },
            count,
            catalog_price,
        );
        // Spoken price on an unknown line has no catalog price to compare with.
        if let Some(price) = decision.unit_price {
            total = total.saturating_add(i64::from(count).saturating_mul(price));
        }
        match status {
            "matched" => counts.matched += 1,
            "ambiguous" => counts.ambiguous += 1,
            _ => counts.unknown += 1,
        }
        counts.lines += 1;
        let spoken = if line.spoken.trim().is_empty() {
            line.query.trim()
        } else {
            line.spoken.trim()
        };
        let mut value = json!({
            "id": Uuid::now_v7(),
            "spoken": spoken.chars().take(120).collect::<String>(),
            "status": status,
            "unit_id": chosen.as_ref().and_then(|s| s.unit.map(|u| u.id)),
            "quantity": count,
            "unit_price": decision.unit_price,
            "price_source": decision.source.as_str(),
            "price_mismatch": decision.mismatch,
            "needs_price": decision.needs_price,
        });
        debug_assert!(decision.source != PriceSource::Catalog || catalog_price.is_some());
        if let Some(sel) = &chosen {
            value["product"] = summary(state, sel.product).await;
        }
        if status == "ambiguous" {
            let mut list = Vec::new();
            for p in &candidates {
                list.push(summary(state, p).await);
            }
            value["candidates"] = json!(list);
        }
        let mut stored = value.clone();
        stored["phrase"] = json!(phrase);
        api_lines.push(value);
        stored_lines.push(stored);
    }

    let method = payment_method(
        parse,
        crate::auth::permissions::can(actor, Action::RecordDebt),
    );
    let mut draft = json!({"lines": api_lines, "payment_method": method, "total": total.max(0)});
    let mut stored =
        json!({"lines": stored_lines, "payment_method": method, "total": total.max(0)});
    if method == "credit" {
        let customer = customer_match(state, actor, parse.customer_name.as_deref()).await?;
        draft["customer"] = customer.clone();
        stored["customer"] = customer;
    }
    Ok(Some(Draft {
        api: draft,
        stored,
        counts,
    }))
}

async fn customer_match(state: &AppState, actor: &Actor, spoken: Option<&str>) -> ApiResult<Value> {
    let pool = crate::auth::data::pool(state)?;
    let spoken = spoken.map(str::trim).filter(|s| !s.is_empty());
    let Some(spoken) = spoken else {
        return Ok(json!({"status": "none"}));
    };
    let band = matching::match_customer(pool, actor.store_id, spoken)
        .await
        .map_err(db)?;
    let ids: Vec<Uuid> = match &band {
        CustomerBand::Matched(id) => vec![*id],
        CustomerBand::Candidates(ids) => ids.clone(),
        CustomerBand::None => vec![],
    };
    let loaded = matching::load_customers(pool, actor.store_id, &ids).await?;
    let find = |id: &Uuid| loaded.iter().find(|(i, _)| i == id).map(|(_, v)| v.clone());
    let spoken_name: String = spoken.chars().take(80).collect();
    Ok(match band {
        CustomerBand::Matched(id) => match find(&id) {
            Some(customer) => {
                json!({"status": "matched", "customer": customer, "spoken_name": spoken_name})
            }
            None => json!({"status": "none", "spoken_name": spoken_name}),
        },
        CustomerBand::Candidates(ids) => {
            let candidates: Vec<Value> = ids.iter().filter_map(find).collect();
            if candidates.is_empty() {
                json!({"status": "none", "spoken_name": spoken_name})
            } else {
                json!({"status": "candidates", "candidates": candidates, "spoken_name": spoken_name})
            }
        }
        CustomerBand::None => json!({"status": "none", "spoken_name": spoken_name}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::model::VoiceParse;

    fn parse(method: &str) -> VoiceParse {
        VoiceParse {
            payment_method: Some(method.into()),
            ..VoiceParse::default()
        }
    }
    #[test]
    fn credit_without_record_debt_is_downgraded_to_cash() {
        assert_eq!(payment_method(&parse("credit"), true), "credit");
        assert_eq!(payment_method(&parse("credit"), false), "cash");
        assert_eq!(payment_method(&parse("transfer"), false), "transfer");
        assert_eq!(payment_method(&parse("bogus"), true), "cash");
        assert_eq!(payment_method(&VoiceParse::default(), true), "cash");
    }
}
