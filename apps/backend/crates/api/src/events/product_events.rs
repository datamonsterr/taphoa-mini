//! Pure, privacy-limited mapping from committed outbox envelopes to product captures.
use crate::analytics::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub struct MemberInfo {
    pub distinct_id: String,
    pub role: Role,
    pub can_enroll: bool,
}
pub type MemberLookup = HashMap<Uuid, MemberInfo>;

/// Unknown event types and intentionally excluded variants are silently ignored.
/// Malformed mapped events fail closed, without logging payloads or customer data.
pub fn map(envelope: &Value, members: &MemberLookup) -> Option<CaptureEvent> {
    let kind = envelope["type"].as_str()?;
    let data = &envelope["data"];
    let filter = match kind {
        "member.changed" => Some(("change", "joined")),
        "stock.changed" => Some(("reason", "adjustment")),
        "debt.recorded" => Some(("kind", "credit_sale")),
        _ => None,
    };
    if let Some((key, expected)) = filter {
        match data[key].as_str() {
            Some(value) if value != expected => return None,
            None => {
                tracing::warn!(event_type = kind, "malformed product event skipped");
                return None;
            }
            _ => {}
        }
    }
    match kind {
        "store.created" | "member.changed" | "product.enrolled" | "scan.completed"
        | "sale.created" | "sale.voided" | "receipt.scanned" | "receipt.confirmed"
        | "stock.changed" | "expense.created" | "price.changed" | "day.closed"
        | "customer.created" | "debt.recorded" | "debt.repaid" | "debt.adjusted" => {}
        _ => return None,
    }
    let event = map_inner(envelope, members);
    if event.is_none() {
        tracing::warn!(
            event_type = kind,
            "malformed or unattributed product event skipped"
        );
    }
    event
}
fn read<T: DeserializeOwned>(data: &Value, key: &str) -> Option<T> {
    serde_json::from_value(data.get(key)?.clone()).ok()
}
fn defaulted<T: DeserializeOwned>(data: &Value, key: &str, default: T) -> Option<T> {
    if data.get(key).is_none() {
        Some(default)
    } else {
        read(data, key)
    }
}
fn via(data: &Value) -> Option<ChangeVia> {
    defaulted(data, "via", ChangeVia::Manual)
}
fn map_inner(envelope: &Value, members: &MemberLookup) -> Option<CaptureEvent> {
    let kind = envelope["type"].as_str()?;
    let data = &envelope["data"];
    data.as_object()?;
    let joined_id = if kind == "member.changed" {
        Some(read::<Uuid>(data, "member_id")?)
    } else {
        None
    };
    let product = match kind {
        "store.created" => ProductEvent::StoreCreated,
        "member.changed" => {
            let member = members.get(&joined_id?)?;
            ProductEvent::MemberJoined {
                role: member.role,
                can_enroll: member.can_enroll,
            }
        }
        "product.enrolled" => ProductEvent::ProductEnrolled {
            reference_count: read(data, "reference_count")?,
            source: read(data, "source")?,
        },
        "scan.completed" => ProductEvent::ScanCompleted {
            purpose: read(data, "purpose")?,
            match_class: match data["match_class"].as_str()? {
                "matched" => MatchClass::Matched,
                "ambiguous" => MatchClass::Ambiguous,
                "unknown" => MatchClass::Unknown,
                _ => return None,
            },
            latency_ms: read(data, "latency_ms")?,
        },
        "sale.created" => {
            let payment_method = read(data, "payment_method")?;
            ProductEvent::SaleCompleted {
                total: read(data, "total")?,
                line_count: read(data, "line_count")?,
                payment_method,
                has_credit: defaulted::<i64>(data, "credit_amount", 0)? > 0
                    || payment_method == PaymentMethod::Credit,
                manual_lines: defaulted(data, "manual_lines", 0)?,
            }
        }
        "sale.voided" => ProductEvent::SaleVoided {
            same_day: defaulted(data, "same_day", false)?,
        },
        "receipt.scanned" => ProductEvent::ReceiptScanned {
            line_count: read(data, "line_count")?,
            matched_lines: read(data, "matched_lines")?,
            latency_ms: read(data, "latency_ms")?,
        },
        "receipt.confirmed" => ProductEvent::ReceiptConfirmed {
            line_count: read(data, "line_count")?,
            via: if via(data)? == ChangeVia::Assistant {
                ReceiptVia::Chat
            } else {
                ReceiptVia::Form
            },
        },
        "stock.changed" => ProductEvent::StockAdjusted {
            reason: StockReason::Adjustment,
            via: via(data)?,
        },
        "expense.created" => ProductEvent::ExpenseAdded {
            category: read(data, "category")?,
            via: via(data)?,
        },
        "price.changed" => ProductEvent::PriceChanged { via: via(data)? },
        "day.closed" => ProductEvent::DayClosed {
            difference_bucket: DifferenceBucket::from_dong(read(data, "difference")?),
        },
        "customer.created" => ProductEvent::CustomerCreated,
        "debt.recorded" => ProductEvent::DebtRecorded {
            amount_bucket: AmountBucket::from_dong(read(data, "amount")?),
            method: DebtMethod::CreditSale,
        },
        "debt.repaid" => {
            let method = read(data, "method")?;
            if !matches!(method, DebtMethod::Cash | DebtMethod::Transfer) {
                return None;
            }
            ProductEvent::DebtRepaid {
                amount_bucket: AmountBucket::from_dong(read(data, "amount")?),
                method,
            }
        }
        "debt.adjusted" => ProductEvent::DebtAdjusted {
            amount_bucket: AmountBucket::from_dong(read(data, "amount")?),
            method: DebtMethod::Adjustment,
        },
        _ => return None,
    };
    let store_id = read(envelope, "store_id")?;
    if !envelope["actor"].is_null() && !envelope["actor"].is_object() {
        return None;
    }
    // Joined events always describe the joining member, even when a lead invited them.
    let member_id = if let Some(id) = joined_id {
        Some(id)
    } else if let Some(id) = envelope["actor"].get("member_id") {
        Some(serde_json::from_value::<Uuid>(id.clone()).ok()?)
    } else if data.get("member_id").is_some() {
        Some(read(data, "member_id")?)
    } else {
        None
    };
    let mut event = if let Some(member_id) = member_id {
        let member = members.get(&member_id)?;
        CaptureEvent::product(
            &EventContext {
                distinct_id: member.distinct_id.clone(),
                store_id,
                member_id,
                role: member.role,
            },
            &product,
        )
    } else {
        let mut properties = product.properties();
        properties.insert("$process_person_profile".into(), json!(false));
        CaptureEvent {
            distinct_id: format!("store:{store_id}"),
            event: product.name().into(),
            properties,
            groups: serde_json::Map::from_iter([("store".into(), json!(store_id))]),
            ..Default::default()
        }
    };
    let id = envelope["id"]
        .as_str()?
        .strip_prefix("evt_")?
        .parse::<i64>()
        .ok()?;
    if id < 0 {
        return None;
    }
    event.uuid = Some(Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        id.to_string().as_bytes(),
    ));
    event.timestamp = Some(
        chrono::DateTime::parse_from_rfc3339(envelope["occurred_at"].as_str()?)
            .ok()?
            .to_utc(),
    );
    Some(event)
}

/// One query per committed relay batch. X1 changes id::text to clerk_user_id here.
pub async fn lookup_members(
    pool: &sqlx::PgPool,
    envelopes: &[Value],
) -> Result<MemberLookup, sqlx::Error> {
    let mut ids = Vec::new();
    for envelope in envelopes {
        for value in [
            &envelope["actor"]["member_id"],
            &envelope["data"]["member_id"],
        ] {
            if let Some(id) = value.as_str().and_then(|id| id.parse::<Uuid>().ok()) {
                ids.push(id);
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    let rows: Vec<(Uuid, String, String, bool)> = sqlx::query_as(
        "SELECT id, id::text AS distinct_id, role, can_enroll FROM members WHERE id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, distinct_id, role, can_enroll)| {
            role.parse().ok().map(|role| {
                (
                    id,
                    MemberInfo {
                        distinct_id,
                        role,
                        can_enroll,
                    },
                )
            })
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn envelope(kind: &str, data: serde_json::Value) -> serde_json::Value {
        json!({"id":"evt_000000000000123","type":kind,"store_id":Uuid::nil(),"occurred_at":"2026-10-26T08:02:03+07:00","actor":null,"data":data})
    }
    fn members() -> MemberLookup {
        MemberLookup::from([
            (
                Uuid::from_u128(1),
                MemberInfo {
                    distinct_id: "user-one".into(),
                    role: Role::Lead,
                    can_enroll: true,
                },
            ),
            (
                Uuid::from_u128(2),
                MemberInfo {
                    distinct_id: "user-two".into(),
                    role: Role::Seller,
                    can_enroll: false,
                },
            ),
        ])
    }
    #[test]
    fn mapping_rows() {
        let cases = [
            ("store.created", json!({}), "store_created", json!({})),
            (
                "member.changed",
                json!({"change":"joined","member_id":Uuid::from_u128(2)}),
                "member_joined",
                json!({"role":"seller","can_enroll":false}),
            ),
            (
                "product.enrolled",
                json!({"reference_count":2,"source":"quick_enroll"}),
                "product_enrolled",
                json!({"reference_count":2,"source":"quick_enroll"}),
            ),
            (
                "scan.completed",
                json!({"purpose":"checkout","match_class":"ambiguous","latency_ms":25}),
                "scan_completed",
                json!({"purpose":"checkout","match_class":"ambiguous","latency_ms":25}),
            ),
            (
                "sale.created",
                json!({"total":5000,"line_count":2,"payment_method":"cash","credit_amount":1000,"manual_lines":1}),
                "sale_completed",
                json!({"total":5000,"line_count":2,"payment_method":"cash","has_credit":true,"manual_lines":1}),
            ),
            (
                "sale.voided",
                json!({}),
                "sale_voided",
                json!({"same_day":false}),
            ),
            (
                "receipt.scanned",
                json!({"line_count":3,"matched_lines":2,"latency_ms":50}),
                "receipt_scanned",
                json!({"line_count":3,"matched_lines":2,"latency_ms":50}),
            ),
            (
                "receipt.confirmed",
                json!({"line_count":2,"via":"assistant"}),
                "receipt_confirmed",
                json!({"line_count":2,"via":"chat"}),
            ),
            (
                "stock.changed",
                json!({"reason":"adjustment","via":"assistant"}),
                "stock_adjusted",
                json!({"reason":"adjustment","via":"assistant"}),
            ),
            (
                "expense.created",
                json!({"category":"dien","via":"manual"}),
                "expense_added",
                json!({"category":"dien","via":"manual"}),
            ),
            (
                "price.changed",
                json!({"via":"assistant"}),
                "price_changed",
                json!({"via":"assistant"}),
            ),
            (
                "day.closed",
                json!({"difference":-20000}),
                "day_closed",
                json!({"difference_bucket":"small"}),
            ),
            ("customer.created", json!({}), "customer_created", json!({})),
            (
                "debt.recorded",
                json!({"kind":"credit_sale","amount":50000}),
                "debt_recorded",
                json!({"amount_bucket":"50k_200k","method":"credit_sale"}),
            ),
            (
                "debt.repaid",
                json!({"amount":200000,"method":"transfer"}),
                "debt_repaid",
                json!({"amount_bucket":"200k_1m","method":"transfer"}),
            ),
            (
                "debt.adjusted",
                json!({"amount":-1000000}),
                "debt_adjusted",
                json!({"amount_bucket":"gte_1m","method":"adjustment"}),
            ),
        ];
        for (kind, data, name, props) in cases {
            let event = map(&envelope(kind, data), &members()).unwrap();
            assert_eq!(event.event, name);
            for (key, value) in props.as_object().unwrap() {
                assert_eq!(event.properties[key], *value, "{kind}: {key}");
            }
        }
    }
    #[test]
    fn skip_rows_and_malformed_data() {
        for kind in [
            "catalog.changed",
            "assistant.action.confirmed",
            "assistant.action.rejected",
            "session.revoked",
            "stock.low",
            "alert.created",
            "alert.resolved",
            "review.line_flagged",
            "review.line_resolved",
            "product.indexed",
            "embedding.backfill",
            "sale.payment_confirmed",
            "customer.updated",
            "store.changed",
        ] {
            assert!(
                map(&envelope(kind, json!({})), &members()).is_none(),
                "{kind}"
            );
        }
        for (kind, data) in [
            ("stock.changed", json!({"reason":"sale"})),
            ("member.changed", json!({"change":"updated"})),
            (
                "member.changed",
                json!({"change":"joined","member_id":Uuid::new_v4()}),
            ),
            ("debt.recorded", json!({"kind":"void"})),
            ("sale.created", json!({"total":"bad"})),
            ("scan.completed", json!({"purpose":"invalid"})),
            (
                "product.enrolled",
                json!({"reference_count":-1,"source":"enroll"}),
            ),
            ("price.changed", json!({"via":"bad"})),
        ] {
            assert!(map(&envelope(kind, data), &members()).is_none(), "{kind}");
        }
    }
    #[test]
    fn actor_fallback_joiner_store_identity_and_deterministic_metadata() {
        let mut e = envelope("customer.created", json!({"member_id":Uuid::from_u128(2)}));
        e["actor"] = json!({"member_id":Uuid::from_u128(1)});
        assert_eq!(map(&e, &members()).unwrap().distinct_id, "user-one");
        e["actor"] = serde_json::Value::Null;
        assert_eq!(map(&e, &members()).unwrap().distinct_id, "user-two");
        e["data"] = json!({});
        let event = map(&e, &members()).unwrap();
        assert_eq!(event.distinct_id, format!("store:{}", Uuid::nil()));
        assert_eq!(event.groups["store"], Uuid::nil().to_string());
        assert_eq!(event.properties["$process_person_profile"], false);
        assert!(!event.properties.contains_key("member_id"));
        assert!(!event.properties.contains_key("role"));
        assert_eq!(event.uuid, Some(Uuid::new_v5(&Uuid::NAMESPACE_OID, b"123")));
        assert_eq!(
            event.timestamp.unwrap().to_rfc3339(),
            "2026-10-26T01:02:03+00:00"
        );
        assert_eq!(event.uuid, map(&e, &members()).unwrap().uuid);
        let mut joined = envelope(
            "member.changed",
            json!({"change":"joined","member_id":Uuid::from_u128(2)}),
        );
        joined["actor"] = json!({"member_id":Uuid::from_u128(1)});
        assert_eq!(map(&joined, &members()).unwrap().distinct_id, "user-two");
        e["actor"] = json!({"member_id":Uuid::new_v4()});
        assert!(map(&e, &members()).is_none());
    }
}
