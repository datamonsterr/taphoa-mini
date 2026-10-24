//! Validates real handler responses against docs/api/openapi.yaml (OpenAPI 3.1 = JSON Schema 2020-12).
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use taphoa_api::{
    AppState,
    images::{ImageRepository, ImageRow},
    router,
    storage::{ObjectStore, SignedUrl},
};
use taphoa_recognition::Segment;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct FakeStore(Mutex<HashMap<String, Vec<u8>>>);
#[async_trait]
impl ObjectStore for FakeStore {
    async fn put(&self, key: &str, _: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(key.into(), bytes);
        Ok(())
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("object {key} not found"))
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        Ok(SignedUrl {
            url: format!("https://fake.test/{key}?signature=abc"),
            expires_at: (SystemTime::now() + ttl).into(),
        })
    }
}
#[derive(Default)]
struct FakeRepository(Mutex<HashMap<Uuid, (ImageRow, Uuid)>>);
#[async_trait]
impl ImageRepository for FakeRepository {
    async fn insert(
        &self,
        row: &ImageRow,
        actor: &taphoa_api::auth::Actor,
    ) -> Result<(), sqlx::Error> {
        self.0
            .lock()
            .unwrap()
            .insert(row.id, (row.clone(), actor.store_id));
        Ok(())
    }
    async fn get(&self, id: Uuid, store_id: Uuid) -> Result<Option<ImageRow>, sqlx::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&id)
            .filter(|(_, owner)| *owner == store_id)
            .map(|(row, _)| row.clone()))
    }
}

mod common;
use common::Contract;

fn state() -> AppState {
    AppState {
        jwt: taphoa_api::auth::JwtKeys::from_secret(&[42; 32]),
        ..AppState::default()
    }
}
fn bearer() -> String {
    let (token, _) = state().jwt.issue(&taphoa_api::auth::Actor {
        member_id: Uuid::nil(),
        store_id: Uuid::nil(),
        session_id: Uuid::nil(),
        role: taphoa_api::auth::Role::Lead,
        can_enroll: true,
    });
    format!("Bearer {token}")
}
fn app() -> Router {
    router(AppState {
        storage: Some(Arc::new(FakeStore::default())),
        image_repository: Some(Arc::new(FakeRepository::default())),
        ..state()
    })
}
async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let mut request = request;
    request
        .headers_mut()
        .insert("authorization", bearer().parse().unwrap());
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).expect("JSON body"))
}
fn upload(purpose: Option<&str>) -> Request<Body> {
    let png = include_bytes!("../../../tests/fixtures/sample.png");
    let mut body = Vec::new();
    if let Some(purpose) = purpose {
        body.extend_from_slice(
            format!("--b\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\n{purpose}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(b"--b\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n");
    body.extend_from_slice(png);
    body.extend_from_slice(b"\r\n--b--\r\n");
    Request::post("/v1/images")
        .header("content-type", "multipart/form-data; boundary=b")
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn health_and_readiness_match_the_contract() {
    let contract = Contract::load();
    let (status, body) = call(
        &app(),
        Request::get("/healthz").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    contract.assert_conforms("/healthz", "get", status, &body);
    // No Postgres/Redis configured: not ready, and the 503 body is still a Readiness.
    let (status, body) = call(&app(), Request::get("/readyz").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    contract.assert_conforms("/readyz", "get", status, &body);
}

#[tokio::test]
async fn image_upload_and_fetch_match_the_contract() {
    let contract = Contract::load();
    let app = app();
    for purpose in [None, Some("expense_receipt")] {
        let (status, created) = call(&app, upload(purpose)).await;
        assert_eq!(status, StatusCode::CREATED);
        contract.assert_conforms("/v1/images", "post", status, &created);
        assert_eq!(created["purpose"], purpose.unwrap_or("other"));
        let id = created["id"].as_str().unwrap();
        let (status, fetched) = call(
            &app,
            Request::get(format!("/v1/images/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        contract.assert_conforms("/v1/images/{imageId}", "get", status, &fetched);
    }
}

#[tokio::test]
async fn error_bodies_match_the_contract() {
    let contract = Contract::load();
    let app = app();
    let (status, body) = call(&app, upload(Some("not-a-purpose"))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    contract.assert_conforms("/v1/images", "post", status, &body);
    let (status, body) = call(
        &app,
        Request::get(format!("/v1/images/{}", Uuid::new_v4()))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    contract.assert_conforms("/v1/images/{imageId}", "get", status, &body);
}

#[test]
fn the_validator_rejects_a_non_conforming_body() {
    let contract = Contract::load();
    let result = std::panic::catch_unwind(|| {
        contract.assert_conforms(
            "/healthz",
            "get",
            StatusCode::OK,
            &json!({"status": "nope"}),
        );
    });
    assert!(result.is_err(), "negative control must fail");
}

#[tokio::test]
async fn segment_points_matches_the_contract() {
    let contract = Contract::load();
    let app = router(AppState {
        storage: Some(Arc::new(FakeStore::default())),
        image_repository: Some(Arc::new(FakeRepository::default())),
        point_segmenter: Some(Arc::new(taphoa_recognition::MockPointSegmenter::new(
            Segment {
                bbox: [10.0, 10.0, 50.0, 50.0],
                score: 0.99,
                area: 2500,
            },
            256,
            192,
        ))),
        ..state()
    });

    let (status, created) = call(&app, upload(Some("enrollment"))).await;
    assert_eq!(status, StatusCode::CREATED);
    let image_id = created["id"].as_str().unwrap();

    let req = Request::post("/v1/segment/points")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "image_id": image_id,
                "points": [{ "x": 800.0, "y": 600.0, "label": 1 }]
            })
            .to_string(),
        ))
        .unwrap();

    let (status, body) = call(&app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    contract.assert_conforms("/v1/segment/points", "post", status, &body);

    let req_invalid = Request::post("/v1/segment/points")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "image_id": image_id,
                "points": []
            })
            .to_string(),
        ))
        .unwrap();
    let (status, err_body) = call(&app, req_invalid).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    contract.assert_conforms("/v1/segment/points", "post", status, &err_body);
}

/// Contract-only checks: implementations land in the dependent stock/receipt tasks.
#[test]
fn stock_and_receipt_input_constraints() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../docs/api/openapi.yaml"
    );
    let doc: Value = serde_norway::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let validate = |name: &str, sample: Value| {
        let schema = &doc["components"]["schemas"][name];
        assert!(schema.is_object(), "missing schema {name}");
        let root = json!({"components": doc["components"], "allOf": [schema]});
        jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&root)
            .unwrap()
            .is_valid(&sample)
    };
    for valid in [
        json!({"count":0}),
        json!({"delta":-2,"note":"count correction"}),
    ] {
        assert!(validate("StockAdjustment", valid));
    }
    for invalid in [
        json!({}),
        json!({"count":2,"delta":1}),
        json!({"count":-1}),
        json!({"delta":0}),
        json!({"delta":1.5}),
        json!({"count":1,"note":"x".repeat(201)}),
    ] {
        assert!(!validate("StockAdjustment", invalid));
    }
    let line = json!({"product_id":Uuid::nil(),"quantity":24,"cost":204000});
    let valid = json!({"lines":[line.clone()],"paid_with":"cash_box"});
    assert!(validate("ReceiptConfirm", valid.clone()));
    for invalid in [
        json!({"lines":[],"paid_with":"cash_box"}),
        json!({"lines":vec![line;101],"paid_with":"cash_box"}),
        json!({"lines":[{"quantity":1,"cost":0}],"paid_with":"other"}),
    ] {
        assert!(!validate("ReceiptConfirm", invalid));
    }
    for (field, value) in [
        ("quantity", json!(0)),
        ("cost", json!(-1)),
        ("quantity", json!(1.5)),
    ] {
        let mut invalid = valid.clone();
        invalid["lines"][0][field] = value;
        assert!(!validate("ReceiptConfirm", invalid));
    }
    assert!(validate(
        "ScanDocument",
        json!({"detected":false,"score":0,"text_lines":0})
    ));
    assert!(!validate(
        "ScanDocument",
        json!({"detected":true,"score":1.1,"text_lines":6})
    ));
    for name in ["ProductPatch", "StorePatch"] {
        assert!(validate(name, json!({"low_stock_threshold":0})));
        assert!(validate(name, json!({"low_stock_threshold":100000})));
        assert!(!validate(name, json!({"low_stock_threshold":-1})));
        assert!(!validate(name, json!({"low_stock_threshold":100001})));
    }
    assert!(
        doc["components"]["schemas"]["Scan"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("document"))
    );
}
