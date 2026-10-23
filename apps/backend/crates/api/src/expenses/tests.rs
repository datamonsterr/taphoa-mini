use super::*;

fn expense() -> Value {
    json!({"id":Uuid::nil(),"spent_at":"2026-05-01T00:00:00Z","amount":100,"category":"khac","paid_with":"cash_box"})
}
fn validate(value: Value) -> bool {
    serde_json::from_value::<CreateExpense>(value).is_ok_and(|e| e.validate().is_ok())
}
#[test]
fn expense_validation_and_unicode_notes() {
    assert!(validate(expense()));
    for bad in [
        json!({"amount":0}),
        json!({"amount":-1}),
        json!({"amount":1.5}),
        json!({"category":"invalid"}),
        json!({"paid_with":"card"}),
        json!({"note":"đ".repeat(501)}),
    ] {
        let mut input = expense();
        input
            .as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        assert!(!validate(input));
    }
    let mut input = expense();
    input["note"] = json!("đ".repeat(500));
    assert!(validate(input));
}
#[test]
fn purchase_totals_quantities_and_overflow() {
    let mut input = expense();
    input["purchase_lines"] = json!([{"product_id":Uuid::nil(),"quantity":2,"unit_cost":50}]);
    assert!(!validate(input.clone()));
    input["category"] = json!("nhap_hang");
    assert!(validate(input.clone()));
    input["amount"] = json!(99);
    assert!(!validate(input.clone()));
    input["amount"] = json!(100);
    for (quantity, cost) in [(0, 50), (-1, 50), (2, -1), (2, i64::MAX)] {
        input["purchase_lines"][0]["quantity"] = json!(quantity);
        input["purchase_lines"][0]["unit_cost"] = json!(cost);
        assert!(!validate(input.clone()));
    }
}
