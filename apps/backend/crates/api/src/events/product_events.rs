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
