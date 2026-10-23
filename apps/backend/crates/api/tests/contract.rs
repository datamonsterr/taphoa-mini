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
struct FakeRepository(Mutex<HashMap<Uuid, ImageRow>>);
#[async_trait]
impl ImageRepository for FakeRepository {
    async fn insert(&self, row: &ImageRow, _: Option<Uuid>) -> Result<(), sqlx::Error> {
        self.0.lock().unwrap().insert(row.id, row.clone());
        Ok(())
    }
    async fn get(&self, id: Uuid) -> Result<Option<ImageRow>, sqlx::Error> {
        Ok(self.0.lock().unwrap().get(&id).cloned())
    }
}

struct Contract(Value);
impl Contract {
    fn load() -> Self {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../docs/api/openapi.yaml"
        );
        let text = std::fs::read_to_string(path).expect("read docs/api/openapi.yaml");
        Self(serde_norway::from_str(&text).expect("parse OpenAPI document"))
    }
    /// Follow a local `#/...` reference (JSON Pointer).
    fn resolve<'a>(&'a self, mut node: &'a Value) -> &'a Value {
        while let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            node = self
                .0
                .pointer(reference.strip_prefix('#').expect("local $ref only"))
                .unwrap_or_else(|| panic!("dangling $ref {reference}"));
        }
        node
    }
    /// Assert `status` is documented for the operation and `body` matches its JSON schema.
    fn assert_conforms(&self, template: &str, method: &str, status: StatusCode, body: &Value) {
        let operation = &self.0["paths"][template][method];
        let response = operation["responses"]
            .get(status.as_str())
            .unwrap_or_else(|| panic!("{method} {template}: {status} is not documented"));
        let schema = &self.resolve(response)["content"]["application/json"]["schema"];
        assert!(
            !schema.is_null(),
            "{method} {template} {status}: no JSON schema"
        );
        // Embed the components so local `#/components/...` $refs resolve from the root.
        let root = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "components": self.0["components"],
            "allOf": [schema],
        });
        let validator = jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&root)
            .expect("build validator");
        let errors: Vec<String> = validator
            .iter_errors(body)
            .map(|error| format!("{}: {error}", error.instance_path()))
            .collect();
        assert!(
            errors.is_empty(),
            "{method} {template} {status} violates the contract: {errors:#?}\nbody: {body}"
        );
    }
}

fn app() -> Router {
    router(AppState {
        storage: Some(Arc::new(FakeStore::default())),
        image_repository: Some(Arc::new(FakeRepository::default())),
        ..AppState::default()
    })
}
async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
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
