//! Sample envelopes validate against docs/api/asyncapi.yaml (no services needed).
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn load(file: &str) -> Value {
    let path = format!("{}/../../../../docs/api/{file}", env!("CARGO_MANIFEST_DIR"));
    serde_norway::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn envelope(kind: &str, data: Value) -> Value {
    json!({
        "id": "evt_000000000000128", "type": kind, "version": 1,
        "store_id": "0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b",
        "occurred_at": "2026-10-23T09:14:02.511+07:00",
        "actor": {"member_id": "0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3c", "session_id": "0192b1f1-7c1e-7a8a-9a51-2a4f0e7d1c3d"},
        "cursor": "AAAAAAAAAIA", "data": data,
    })
}
const U1: &str = "0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c01";
const U2: &str = "0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c02";

fn samples() -> Vec<(&'static str, Value)> {
    vec![
        ("catalog.changed", json!({"entity":"product","ids":[U1,U2]})),
        (
            "price.changed",
            json!({"product_id":U1,"unit_id":null,"field":"price","old_value":9000,"new_value":10000,"source":"margin_alert"}),
        ),
        (
            "store.changed",
            json!({"fields":["name","margin_threshold_pct"]}),
        ),
        ("member.changed", json!({"member_id":U1,"change":"joined"})),
        (
            "session.revoked",
            json!({"session_id":U1,"reason":"token_reuse"}),
        ),
        (
            "sale.created",
            json!({"sale_id":U1,"code":"TH0042","total":24500,"payment_method":"transfer","member_id":U2,"business_date":"2026-10-23","line_count":3,"credit_amount":5000,"customer_id":U2}),
        ),
        (
            "customer.created",
            json!({"customer_id":U1,"balance":0,"archived":false}),
        ),
        (
            "customer.updated",
            json!({"customer_id":U1,"balance":-5000,"archived":true}),
        ),
        (
            "debt.recorded",
            json!({"entry_id":U1,"customer_id":U2,"kind":"credit_sale","amount":10000,"sale_id":U1,"balance":10000,"business_date":"2026-10-23"}),
        ),
        (
            "debt.repaid",
            json!({"entry_id":U1,"customer_id":U2,"amount":15000,"method":"cash","balance":-5000,"business_date":"2026-10-23"}),
        ),
        (
            "debt.adjusted",
            json!({"entry_id":U1,"customer_id":U2,"amount":-5000,"balance":-10000,"business_date":"2026-10-23"}),
        ),
        (
            "sale.voided",
            json!({"sale_id":U1,"reason":"nhap nham","voided_by":U2,"total":24500}),
        ),
        (
            "review.line_flagged",
            json!({"line_id":U1,"sale_id":U2,"reason":"price_mismatch","unit_price":10000}),
        ),
        (
            "review.line_resolved",
            json!({"line_id":U1,"action":"enrolled","product_id":U2}),
        ),
        (
            "expense.created",
            json!({"expense_id":U1,"amount":150000,"category":"nhap_hang","business_date":"2026-10-23"}),
        ),
        (
            "alert.created",
            json!({"alert_id":U1,"product_id":U2,"cost_price":8500,"selling_price":9000,"margin_pct":5.5,"suggested_price":10000}),
        ),
        (
            "alert.resolved",
            json!({"alert_id":U1,"status":"accepted","new_price":10000}),
        ),
        (
            "day.closed",
            json!({"business_date":"2026-10-23","expected_cash":1200000,"counted_cash":1190000,"difference":-10000}),
        ),
        (
            "sale.payment_confirmed",
            json!({"sale_id":U1,"amount":24500,"bank_ref":"FT123"}),
        ),
        (
            "scan.completed",
            json!({"scan_id":U1,"mode":"multi","detections":4,"timings":{"segment":2100,"embed":300,"search":40,"total":2600},"model":"dinov2-vits14-onnx@1"}),
        ),
        (
            "embedding.backfill",
            json!({"from_model":"a@1","to_model":"b@1"}),
        ),
        (
            "stock.changed",
            json!({"product_id":U1,"stock_quantity":-1,"reason":"sale"}),
        ),
        (
            "stock.low",
            json!({"product_id":U1,"name":"Coca-Cola lon","stock_quantity":5,"threshold":5}),
        ),
        (
            "receipt.confirmed",
            json!({"receipt_id":U1,"expense_id":U2,"total":204000,"line_count":1}),
        ),
        (
            "product.indexed",
            json!({"product_id":U1,"index_status":"ready","reference_count":3}),
        ),
    ]
}

fn validator(doc: &Value, message: &Value) -> jsonschema::Validator {
    let root = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "components": doc["components"],
        "allOf": [message["payload"]],
    });
    jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&root)
        .expect("build validator")
}
fn message_for<'a>(doc: &'a Value, kind: &str) -> &'a Value {
    doc["components"]["messages"]
        .as_object()
        .unwrap()
        .values()
        .find(|m| m["name"] == kind)
        .unwrap_or_else(|| panic!("asyncapi has no message {kind}"))
}

#[test]
fn every_event_type_has_a_valid_sample_envelope() {
    let doc = load("asyncapi.yaml");
    for (kind, data) in samples() {
        let sample = envelope(kind, data);
        let errors: Vec<String> = validator(&doc, message_for(&doc, kind))
            .iter_errors(&sample)
            .map(|e| format!("{}: {e}", e.instance_path()))
            .collect();
        assert!(errors.is_empty(), "{kind}: {errors:#?}");
    }
}

#[test]
fn samples_cover_every_message_and_reject_broken_payloads() {
    let doc = load("asyncapi.yaml");
    let documented: BTreeSet<String> = doc["components"]["messages"]
        .as_object()
        .unwrap()
        .values()
        .map(|m| m["name"].as_str().unwrap().to_string())
        .collect();
    let sampled: BTreeSet<String> = samples().iter().map(|(k, _)| k.to_string()).collect();
    assert_eq!(
        documented, sampled,
        "add a sample for each documented message"
    );

    let v = validator(&doc, message_for(&doc, "store.changed"));
    let mut bad = envelope("store.changed", json!({"fields":["name"]}));
    bad["id"] = json!("evt_12"); // not 15 digits
    assert!(!v.is_valid(&bad));
    let mut wrong_type = envelope("price.changed", json!({"fields":["name"]}));
    wrong_type["type"] = json!("price.changed");
    assert!(
        !v.is_valid(&wrong_type),
        "type const and data shape are enforced"
    );
    assert!(
        !v.is_valid(&envelope("store.changed", json!({}))),
        "data.fields is required"
    );
}

#[test]
fn openapi_store_event_enum_matches_the_store_channel_messages() {
    let asyncapi = load("asyncapi.yaml");
    let openapi = load("openapi.yaml");
    let from_openapi: BTreeSet<String> =
        openapi["components"]["schemas"]["StoreEvent"]["properties"]["type"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
    let channel = &asyncapi["channels"]["storeEventStream"]["messages"];
    let from_channel: BTreeSet<String> = channel
        .as_object()
        .unwrap()
        .values()
        .map(|m| {
            let target = m["$ref"].as_str().unwrap().trim_start_matches('#');
            asyncapi.pointer(target).unwrap()["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(from_openapi, from_channel);
}

#[test]
fn debt_events_preserve_signed_balances_and_exclude_customer_details() {
    let doc = load("asyncapi.yaml");
    for (kind, data) in samples()
        .into_iter()
        .filter(|(kind, _)| kind.starts_with("customer.") || kind.starts_with("debt."))
    {
        let v = validator(&doc, message_for(&doc, kind));
        for field in ["name", "phone", "note"] {
            let mut private = data.clone();
            private[field] = json!("private customer detail");
            assert!(
                !v.is_valid(&envelope(kind, private)),
                "{kind} rejects {field}"
            );
        }
    }
    let repaid = validator(&doc, message_for(&doc, "debt.repaid"));
    for amount in [0, -1] {
        assert!(!repaid.is_valid(&envelope(
            "debt.repaid",
            json!({
                "entry_id":U1,"customer_id":U2,"amount":amount,"method":"cash",
                "balance":-5000,"business_date":"2026-10-23"
            })
        )));
    }
    let recorded = validator(&doc, message_for(&doc, "debt.recorded"));
    assert!(recorded.is_valid(&envelope(
        "debt.recorded",
        json!({
            "entry_id":U1,"customer_id":U2,"kind":"void","amount":-10000,
            "sale_id":U1,"balance":-5000,"business_date":"2026-10-23"
        })
    )));
    let sale = validator(&doc, message_for(&doc, "sale.created"));
    let mut credit_sale = samples()
        .into_iter()
        .find(|(kind, _)| *kind == "sale.created")
        .unwrap()
        .1;
    credit_sale["payment_method"] = json!("credit");
    credit_sale["credit_amount"] = credit_sale["total"].clone();
    assert!(sale.is_valid(&envelope("sale.created", credit_sale.clone())));
    credit_sale["credit_amount"] = json!(0);
    credit_sale["customer_id"] = Value::Null;
    credit_sale["payment_method"] = json!("cash");
    assert!(sale.is_valid(&envelope("sale.created", credit_sale)));
}
