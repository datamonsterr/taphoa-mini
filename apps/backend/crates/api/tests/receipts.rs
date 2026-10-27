//! Receipt API integration tests against disposable PostgreSQL, Redis and object storage.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::{Contract, world::World};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    w: &World,
    method: &str,
    path: &str,
    token: &str,
    key: &str,
    body: Value,
    expected: StatusCode,
) -> Value {
    let response = w
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 << 20).await.unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    assert_eq!(status, expected, "{method} {path}: {value}");
    if status != StatusCode::NO_CONTENT {
        let template = if path.contains("/confirm") {
            "/v1/receipts/{receiptId}/confirm"
        } else if path.starts_with("/v1/receipts/") {
            "/v1/receipts/{receiptId}"
        } else {
            "/v1/receipts"
        };
        Contract::load().assert_conforms(template, &method.to_lowercase(), status, &value);
    }
    value
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn receipts_require_enrollment_permission() {
    let w = World::new().await;
    for method in ["GET", "POST"] {
        request(
            &w,
            method,
            "/v1/receipts",
            &w.seller,
            "seller",
            json!({"image_id":Uuid::new_v4()}),
            StatusCode::FORBIDDEN,
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn receipts_report_missing_ocr() {
    let w = World::new().await;
    let result = request(
        &w,
        "POST",
        "/v1/receipts",
        &w.lead,
        "no-ocr",
        json!({"image_id":Uuid::new_v4()}),
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    assert_eq!(result["code"], "ocr_unavailable");
}

use std::sync::Arc;
use taphoa_api::{
    decisions::{DecisionError, FakeDecisions},
    receipts::{OcrText, parse_lines},
    storage::{S3Store, StorageConfig},
};
use taphoa_recognition::ocr::{FakeReceiptOcr, OcrLine};

const PHOTO: &[u8] = include_bytes!("../../recognition/tests/fixtures/receipts/receipt-1.jpg");
fn fixture_lines() -> Vec<OcrLine> {
    [
        "ĐẠI LÝ TẠP HÓA MINH ANH",
        "12 Nguyễn Trãi, 0.1, TPHCM",
        "HÓA ĐƠN BÁN HÀNG 25/10/2026",
        "Tên hàng SL Đơn giá T. Tiền",
        "Coca-Cola lon 330ml 24 8.500 204.000",
        "Mì Hảo Hảo tôm chua cay 30 4.200 126.000",
        "Nước suối Aquafina 500ml 12 5.000 60.000",
        "Bánh Chocopie hộp 5 13.200 66.000",
        "Tổng cộng: 456.000",
        "Cảm ơn quý kháchl",
    ]
    .into_iter()
    .enumerate()
    .map(|(i, text)| OcrLine {
        text: text.into(),
        confidence: 0.99,
        bbox: [0., i as f32 * 20., 500., 15.],
    })
    .collect()
}
async fn setup(fail_decisions: bool) -> (World, Uuid, Vec<Uuid>, Arc<FakeDecisions>) {
    let mut w = World::new().await;
    let mut products = Vec::new();
    for (name, price) in [
        ("Coca-Cola lon", 8000),
        ("Mì Hảo Hảo", 4000),
        ("Nước suối Aquafina 500ml", 6000),
        ("Bánh Chocopie hộp", 14000),
    ] {
        products.push(w.product(name, price, None).await);
    }
    let storage = S3Store::new(&StorageConfig::from_env().unwrap().expect("storage env")).await;
    storage.ensure_bucket().await.unwrap();
    w.state.storage = Some(Arc::new(storage));
    let photo = Uuid::now_v7();
    let key = format!("receipts/{photo}.jpg");
    w.state
        .storage
        .as_ref()
        .unwrap()
        .put(&key, "image/jpeg", PHOTO.to_vec())
        .await
        .unwrap();
    sqlx::query("INSERT INTO images(id,store_id,object_key,content_type,byte_size,purpose) VALUES($1,$2,$3,'image/jpeg',$4,'checkout')").bind(photo).bind(w.store_id).bind(key).bind(PHOTO.len() as i64).execute(w.pool()).await.unwrap();
    let lines = fixture_lines();
    let parsed = parse_lines(
        &lines
            .iter()
            .map(|l| OcrText {
                text: l.text.clone(),
                confidence: l.confidence,
                bbox: l.bbox,
            })
            .collect::<Vec<_>>(),
    );
    let mut answers = serde_json::Map::new();
    for (i, line) in parsed.iter().enumerate() {
        let role = if (4..8).contains(&line.position) {
            "item"
        } else {
            "total"
        };
        answers.insert(format!("role_{i}"), json!({"type":"choice","choice":role}));
        answers.insert(
            format!("match_{i}"),
            json!({"type":"choice","choice":"p0","probabilities":{"p0":0.95}}),
        );
    }
    let result = if fail_decisions {
        Err(DecisionError::Transport)
    } else {
        Ok(serde_json::from_value(json!({"answers":answers})).unwrap())
    };
    let decisions = Arc::new(FakeDecisions::new(
        "inception/mercury-decide:free",
        [result],
    ));
    w.state.receipt_ocr = Some(Arc::new(FakeReceiptOcr { lines }));
    w.state.decisions = Some(decisions.clone());
    w.app = taphoa_api::router(w.state.clone());
    (w, photo, products, decisions)
}
async fn create(w: &World, photo: Uuid, key: &str) -> Value {
    request(
        w,
        "POST",
        "/v1/receipts",
        &w.lead,
        key,
        json!({"image_id":photo}),
        StatusCode::CREATED,
    )
    .await
}
fn confirm_body(receipt: &Value) -> Value {
    json!({"paid_with":"cash_box","lines":receipt["lines"].as_array().unwrap().iter().map(|l|json!({"line_id":l["id"],"product_id":l["product_id"],"quantity":l["quantity"],"cost":l["cost"]})).collect::<Vec<_>>()})
}
#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn create_shape_timings_prefilter_and_concurrent_replay() {
    let (w, photo, products, decisions) = setup(false).await;
    let (a, b) = tokio::join!(create(&w, photo, "same"), create(&w, photo, "same"));
    assert_eq!(a["id"], b["id"]);
    assert_eq!(decisions.requests().len(), 1);
    assert_eq!(a["status"], "draft");
    assert_eq!(a["total"], 456000);
    assert_eq!(a["parser"], "decisions");
    assert_eq!(a["lines"].as_array().unwrap().len(), 4);
    for (i, p) in products.iter().enumerate() {
        assert_eq!(a["lines"][i]["product_id"], p.to_string());
    }
    for field in ["ocr", "parse", "decisions", "total"] {
        assert!(a["timings"][field].is_u64());
    }
    let req = decisions.requests();
    assert!(
        serde_json::to_string(&req[0])
            .unwrap()
            .contains("Coca-Cola lon")
    );
    assert!(
        serde_json::to_string(&req[0])
            .unwrap()
            .contains("Mì Hảo Hảo")
    );
    request(
        &w,
        "POST",
        "/v1/receipts",
        &w.lead,
        "same",
        json!({"image_id":Uuid::new_v4()}),
        StatusCode::CONFLICT,
    )
    .await;
}
#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn create_errors_and_fallback() {
    let (mut w, photo, products, _) = setup(true).await;
    let a = create(&w, photo, "fallback").await;
    assert_eq!(a["parser"], "fallback");
    assert_eq!(a["total"], 456000);
    assert_eq!(a["lines"].as_array().unwrap().len(), 4);
    assert_eq!(a["lines"][0]["product_id"], products[0].to_string());
    assert_eq!(a["lines"][1]["product_id"], products[1].to_string());
    let other = World::new().await;
    let foreign = Uuid::now_v7();
    sqlx::query("INSERT INTO images(id,store_id,object_key,content_type,byte_size) VALUES($1,$2,$3,'image/jpeg',1)").bind(foreign).bind(other.store_id).bind(format!("foreign/{foreign}")).execute(w.pool()).await.unwrap();
    request(
        &w,
        "POST",
        "/v1/receipts",
        &w.lead,
        "foreign",
        json!({"image_id":foreign}),
        StatusCode::NOT_FOUND,
    )
    .await;
    w.state.receipt_ocr = Some(Arc::new(FakeReceiptOcr::default()));
    w.app = taphoa_api::router(w.state.clone());
    let a = request(
        &w,
        "POST",
        "/v1/receipts",
        &w.lead,
        "empty",
        json!({"image_id":photo}),
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    assert_eq!(a["code"], "no_text");
}
#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn list_get_discard_filter_and_store_isolation() {
    let (w, photo, _, _) = setup(true).await;
    let a = create(&w, photo, "first").await;
    let b = create(&w, photo, "second").await;
    let path = format!("/v1/receipts/{}", a["id"].as_str().unwrap());
    let got = request(&w, "GET", &path, &w.lead, "", Value::Null, StatusCode::OK).await;
    assert_eq!(got["lines"], a["lines"]);
    let page = request(
        &w,
        "GET",
        "/v1/receipts?limit=1",
        &w.lead,
        "",
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(page["items"][0]["id"], b["id"]);
    assert_eq!(page["items"][0]["line_count"], 4);
    assert_eq!(page["items"][0]["matched_count"], 4);
    let next = request(
        &w,
        "GET",
        &format!(
            "/v1/receipts?limit=1&cursor={}",
            page["next_cursor"].as_str().unwrap()
        ),
        &w.lead,
        "",
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(next["items"][0]["id"], a["id"]);
    assert!(next["next_cursor"].is_null());
    request(
        &w,
        "DELETE",
        &path,
        &w.lead,
        "",
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    let filtered = request(
        &w,
        "GET",
        "/v1/receipts?status=discarded",
        &w.lead,
        "",
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["items"][0]["id"], a["id"]);
    let other = World::new().await;
    request(
        &other,
        "GET",
        &path,
        &other.lead,
        "",
        Value::Null,
        StatusCode::NOT_FOUND,
    )
    .await;
    request(
        &other,
        "DELETE",
        &path,
        &other.lead,
        "",
        Value::Null,
        StatusCode::NOT_FOUND,
    )
    .await;
}
#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn confirm_creates_expense_purchase_stock_events_and_replays() {
    let (w, photo, products, _) = setup(false).await;
    let a = create(&w, photo, "create").await;
    let id = a["id"].as_str().unwrap();
    let path = format!("/v1/receipts/{id}/confirm");
    let mut body = confirm_body(&a);
    // Non-divisible line costs use ceil(unit cost), while expense amount stays sum(cost).
    body["lines"][0]["cost"] = json!(204001);
    body["spent_at"] = json!("2026-10-24T18:00:00Z");
    let (first, second) = tokio::join!(
        request(
            &w,
            "POST",
            &path,
            &w.lead,
            "confirm",
            body.clone(),
            StatusCode::OK
        ),
        request(
            &w,
            "POST",
            &path,
            &w.lead,
            "confirm",
            body.clone(),
            StatusCode::OK
        )
    );
    assert_eq!(first["lines"], second["lines"]);
    assert_eq!(first["expense_id"], second["expense_id"]);
    // Presigned URLs are fresh on read; every persisted response field replays exactly.
    let mut replay_body = second.clone();
    replay_body["image_url"] = first["image_url"].clone();
    assert_eq!(first, replay_body);
    assert_eq!(first["total"], 456001);
    assert_eq!(first["status"], "confirmed");
    let expense: Uuid = first["expense_id"].as_str().unwrap().parse().unwrap();
    let (amount, category, image, business_date): (i64, String, Uuid, chrono::NaiveDate) =
        sqlx::query_as("SELECT amount,category,image_id,business_date FROM expenses WHERE id=$1")
            .bind(expense)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(amount, 456001);
    assert_eq!(category, "nhap_hang");
    assert_eq!(image, photo);
    assert_eq!(business_date.to_string(), "2026-10-25");
    let costs: Vec<(Uuid, i32, i64)> = sqlx::query_as(
        "SELECT product_id,quantity,unit_cost FROM purchase_lines WHERE expense_id=$1",
    )
    .bind(expense)
    .fetch_all(w.pool())
    .await
    .unwrap();
    assert_eq!(costs.len(), 4);
    assert!(costs.contains(&(products[0], 24, 8501)));
    for (i, p) in products.iter().enumerate() {
        let (stock, cost): (Option<i32>, Option<i64>) =
            sqlx::query_as("SELECT stock_quantity,cost_price FROM products WHERE id=$1")
                .bind(p)
                .fetch_one(w.pool())
                .await
                .unwrap();
        assert_eq!(stock, Some([24, 30, 12, 5][i]));
        assert_eq!(cost, Some([8501, 4200, 5000, 13200][i]));
    }
    assert_eq!(w.events("stock.changed").await, 4);
    assert_eq!(w.events("expense.created").await, 1);
    assert_eq!(w.events("receipt.confirmed").await, 1);
    let scanned: Value = sqlx::query_scalar(
        "SELECT payload->'data' FROM outbox_events WHERE store_id=$1 AND type='receipt.scanned'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert!(scanned["line_count"].as_u64().is_some());
    assert!(scanned["matched_lines"].as_u64().is_some());
    assert!(scanned["latency_ms"].as_u64().is_some());
    assert!(w.events("alert.created").await > 0);
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE store_id=$1 AND type='receipt.confirmed'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    let doc: Value =
        serde_norway::from_str(include_str!("../../../../../docs/api/asyncapi.yaml")).unwrap();
    let schema = doc["components"]["messages"]
        .as_object()
        .unwrap()
        .values()
        .find(|m| m["name"] == "receipt.confirmed")
        .unwrap();
    let root = json!({"components":doc["components"],"allOf":[schema["payload"]]});
    assert!(
        jsonschema::draft202012::new(&root)
            .unwrap()
            .is_valid(&payload),
        "{payload}"
    );
    let err = request(
        &w,
        "POST",
        &path,
        &w.lead,
        "another",
        body,
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(err["code"], "already_confirmed");
    request(
        &w,
        "DELETE",
        &format!("/v1/receipts/{id}"),
        &w.lead,
        "",
        Value::Null,
        StatusCode::CONFLICT,
    )
    .await;
}
#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn confirm_validation_drops_lines_adds_lines_and_enroller_permission() {
    let (w, photo, products, _) = setup(false).await;
    let a = create(&w, photo, "create").await;
    let path = format!("/v1/receipts/{}/confirm", a["id"].as_str().unwrap());
    let line = json!({"product_id":products[0],"quantity":3,"cost":100});
    for lines in [
        json!([]),
        json!([{"product_id":Uuid::new_v4(),"quantity":1,"cost":10}]),
        json!([{"product_id":products[0],"quantity":0,"cost":10}]),
        json!([{"product_id":products[0],"quantity":1,"cost":-1}]),
        json!(vec![line.clone(); 101]),
        json!([{"line_id":Uuid::new_v4(),"product_id":products[0],"quantity":1,"cost":10}]),
    ] {
        request(
            &w,
            "POST",
            &path,
            &w.lead,
            "invalid",
            json!({"lines":lines,"paid_with":"other"}),
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
    }
    let other = World::new().await;
    let p = other.product("Foreign", 10, None).await;
    request(
        &w,
        "POST",
        &path,
        &w.lead,
        "foreign",
        json!({"lines":[{"product_id":p,"quantity":1,"cost":10}],"paid_with":"other"}),
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    sqlx::query("UPDATE products SET archived=true WHERE id=$1")
        .bind(products[1])
        .execute(w.pool())
        .await
        .unwrap();
    request(
        &w,
        "POST",
        &path,
        &w.lead,
        "archived",
        json!({"lines":[{"product_id":products[1],"quantity":1,"cost":10}],"paid_with":"other"}),
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    request(
        &w,
        "POST",
        &path,
        &w.seller,
        "seller",
        confirm_body(&a),
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_eq!(w.events("expense.created").await, 0);
    sqlx::query("UPDATE members SET can_enroll=true WHERE id=$1")
        .bind(w.seller_id)
        .execute(w.pool())
        .await
        .unwrap();
    let result = request(
        &w,
        "POST",
        &path,
        &w.seller,
        "enroller",
        json!({"lines":[line],"paid_with":"other"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(result["lines"].as_array().unwrap().len(), 1);
    assert_eq!(result["lines"][0]["quantity"], 3);
    assert_eq!(result["total"], 100);
    assert_ne!(result["lines"][0]["id"], a["lines"][0]["id"]);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM receipt_lines WHERE receipt_id=$1")
        .bind(a["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
#[ignore = "real OCR_* models, OPENROUTER_API_KEY and database/storage services"]
async fn real_models_create_receipt_under_six_seconds() {
    use taphoa_api::{
        config::Config,
        decisions::{DecisionsConfig, OpenRouterDecisions},
    };
    // Only the OCR_* settings matter here; supply a placeholder Clerk issuer so the
    // config loads in CI, which sets no CLERK_* variables.
    let config = Config::from_lookup(|key| {
        std::env::var(key)
            .ok()
            .or_else(|| (key == "CLERK_ISSUER").then(|| common::clerk::TEST_ISSUER.into()))
    })
    .unwrap();
    let (Some(ocr), Some(decisions)) =
        (config.ocr().unwrap(), DecisionsConfig::from_env().unwrap())
    else {
        eprintln!("skipping: OCR_* model paths and OPENROUTER_API_KEY required");
        return;
    };
    let (mut w, photo, _, _) = setup(false).await;
    w.state.receipt_ocr = Some(ocr);
    w.state.decisions = Some(Arc::new(OpenRouterDecisions::new(decisions).unwrap()));
    w.app = taphoa_api::router(w.state.clone());
    let start = std::time::Instant::now();
    let receipt = create(&w, photo, "real").await;
    let elapsed = start.elapsed();
    eprintln!(
        "real receipt wall={}ms timings={} parser={} model={}",
        elapsed.as_millis(),
        receipt["timings"],
        receipt["parser"],
        receipt["model"]
    );
    assert!(elapsed.as_millis() < 6000, "{elapsed:?}");
    let expected: Value = serde_json::from_str(include_str!(
        "../../recognition/tests/fixtures/receipts/receipt-1.json"
    ))
    .unwrap();
    assert_eq!(receipt["total"], expected["total"]);
    let actual: Vec<Value> = receipt["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(
            |l| json!({"product_name":l["product_name"],"quantity":l["quantity"],"cost":l["cost"]}),
        )
        .collect();
    assert_eq!(json!(actual), expected["lines"]);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn confirmation_stock_overflow_rolls_back_expense_alerts_and_receipt() {
    let (w, photo, products, _) = setup(false).await;
    let draft = create(&w, photo, "create").await;
    sqlx::query("UPDATE products SET stock_quantity=$2 WHERE id=$1")
        .bind(products[0])
        .bind(i32::MAX)
        .execute(w.pool())
        .await
        .unwrap();
    request(
        &w,
        "POST",
        &format!("/v1/receipts/{}/confirm", draft["id"].as_str().unwrap()),
        &w.lead,
        "overflow",
        confirm_body(&draft),
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    assert_eq!(w.events("expense.created").await, 0);
    assert_eq!(w.events("alert.created").await, 0);
    assert_eq!(w.events("stock.changed").await, 0);
    assert_eq!(w.events("receipt.confirmed").await, 0);
    let (status, expense): (String, Option<Uuid>) =
        sqlx::query_as("SELECT status,expense_id FROM receipts WHERE id=$1")
            .bind(draft["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(status, "draft");
    assert_eq!(expense, None);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM expenses WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let cost: Option<i64> = sqlx::query_scalar("SELECT cost_price FROM products WHERE id=$1")
        .bind(products[0])
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(cost, None);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn zero_cost_receipt_tracks_free_stock_without_relaxing_expense_api() {
    let (w, photo, products, _) = setup(false).await;
    let draft = create(&w, photo, "create").await;
    let receipt = request(
        &w,
        "POST",
        &format!("/v1/receipts/{}/confirm", draft["id"].as_str().unwrap()),
        &w.lead,
        "free",
        json!({"paid_with":"other","lines":[{"product_id":products[0],"quantity":2,"cost":0}]}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(receipt["total"], 0);
    let expense: Uuid = receipt["expense_id"].as_str().unwrap().parse().unwrap();
    let row:(i64,i64,i32)=sqlx::query_as("SELECT e.amount,l.unit_cost,l.quantity FROM expenses e JOIN purchase_lines l ON l.expense_id=e.id WHERE e.id=$1").bind(expense).fetch_one(w.pool()).await.unwrap();
    assert_eq!(row, (0, 0, 2));
    let stock: Option<i32> = sqlx::query_scalar("SELECT stock_quantity FROM products WHERE id=$1")
        .bind(products[0])
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(stock, Some(2));
    w.checked(
        "GET",
        &format!("/v1/expenses/{expense}"),
        "/v1/expenses/{expenseId}",
        &w.lead,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(w.call("POST","/v1/expenses",&w.lead,json!({"id":Uuid::now_v7(),"spent_at":chrono::Utc::now(),"amount":0,"category":"nhap_hang","paid_with":"other"})).await.status,StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL, REDIS_URL and storage"]
async fn decisions_cannot_persist_the_receipt_total_as_an_item() {
    let (mut w, photo, _, _) = setup(false).await;
    let parsed = parse_lines(
        &fixture_lines()
            .iter()
            .map(|l| OcrText {
                text: l.text.clone(),
                confidence: l.confidence,
                bbox: l.bbox,
            })
            .collect::<Vec<_>>(),
    );
    let mut answers = serde_json::Map::new();
    for i in 0..parsed.len() {
        answers.insert(
            format!("role_{i}"),
            json!({"type":"choice","choice":"item"}),
        );
        answers.insert(
            format!("match_{i}"),
            json!({"type":"choice","choice":"p0","probabilities":{"p0":0.95}}),
        );
    }
    w.state.decisions = Some(Arc::new(FakeDecisions::new(
        "model",
        [Ok(
            serde_json::from_value(json!({"answers":answers})).unwrap()
        )],
    )));
    w.app = taphoa_api::router(w.state.clone());
    let receipt = create(&w, photo, "adversarial-roles").await;
    assert_eq!(receipt["parser"], "decisions");
    assert_eq!(receipt["total"], 456000);
    assert_eq!(receipt["lines"].as_array().unwrap().len(), 4);
}
