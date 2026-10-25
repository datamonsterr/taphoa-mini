use super::*;
use crate::storage::tests::FakeStore;
use axum::{
    body::{Body, to_bytes},
    http::Request,
    response::Response,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tower::ServiceExt;

#[derive(Default)]
struct FakeRepository {
    rows: Mutex<HashMap<Uuid, (ImageRow, Option<Uuid>)>>,
    fail_insert: AtomicBool,
}
#[async_trait]
impl ImageRepository for FakeRepository {
    async fn insert(&self, row: &ImageRow, actor: &Actor) -> Result<(), sqlx::Error> {
        if self.fail_insert.load(Ordering::Relaxed) {
            return Err(sqlx::Error::Protocol("injected insert failure".into()));
        }
        self.rows
            .lock()
            .unwrap()
            .insert(row.id, (row.clone(), Some(actor.store_id)));
        Ok(())
    }
    async fn get(&self, id: Uuid, store_id: Uuid) -> Result<Option<ImageRow>, sqlx::Error> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .get(&id)
            .filter(|(_, owner)| *owner == Some(store_id))
            .map(|(row, _)| row.clone()))
    }
}
// Handler unit tests supply an explicit actor. Real Clerk/membership extraction is
// covered by auth_flow and storage integration tests.
fn test_state() -> AppState {
    AppState::default()
}
fn test_bearer() -> String {
    "Bearer fixture".into()
}
struct FixtureActor(Actor);
impl axum::extract::FromRequestParts<AppState> for FixtureActor {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _: &AppState,
    ) -> Result<Self, ApiError> {
        let store = match parts
            .headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
        {
            Some("Bearer fixture") => Uuid::nil(),
            Some("Bearer foreign") => Uuid::from_u128(1),
            _ => return Err(ApiError::unauthorized()),
        };
        Ok(Self(Actor {
            clerk_user_id: "user_fixture".into(),
            member_id: Uuid::nil(),
            store_id: store,
            clerk_session_id: "sess_fixture".into(),
            role: crate::auth::Role::Lead,
            can_enroll: true,
        }))
    }
}
fn router(state: AppState) -> axum::Router {
    use axum::{
        extract::DefaultBodyLimit,
        routing::{get, post},
    };
    axum::Router::new()
        .route("/readyz",get(crate::readyz))
        .route("/v1/images",post(|state:State<AppState>,FixtureActor(actor):FixtureActor,multipart:Result<Multipart,MultipartRejection>|async move {upload(state,actor,multipart).await})
            .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(MAX_IMAGE_REQUEST_BYTES))
            .layer(tower_http::limit::RequestBodyLimitLayer::new(MAX_IMAGE_REQUEST_BYTES)))
        .route("/v1/images/{id}",get(|state:State<AppState>,FixtureActor(actor):FixtureActor,id:Path<String>|async move {get_image(state,actor,id).await}))
        .with_state(state)
}
fn setup() -> (AppState, Arc<FakeStore>, Arc<FakeRepository>) {
    let objects = Arc::new(FakeStore::default());
    let rows = Arc::new(FakeRepository::default());
    (
        AppState {
            storage: Some(objects.clone()),
            image_repository: Some(rows.clone()),
            ..test_state()
        },
        objects,
        rows,
    )
}
fn multipart(fields: &[(&str, &[u8])]) -> Request<Body> {
    let mut body = Vec::new();
    for (name, bytes) in fields {
        body.extend_from_slice(format!("--test\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: text/plain\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"--test--\r\n");
    Request::post("/v1/images")
        .header("authorization", test_bearer())
        .header("content-type", "multipart/form-data; boundary=test")
        .body(Body::from(body))
        .unwrap()
}
async fn json(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap()
}
const PNG: &[u8] = include_bytes!("../../../../tests/fixtures/sample.png");

#[tokio::test]
async fn upload_and_get_presign_fresh_urls_and_store_only_metadata() {
    for (bytes, mime, ext) in [
        (PNG, "image/png", "png"),
        (b"\xff\xd8\xfftest".as_slice(), "image/jpeg", "jpg"),
        (b"RIFF\x04\0\0\0WEBPtest".as_slice(), "image/webp", "webp"),
    ] {
        let (state, objects, rows) = setup();
        let app = router(state);
        let store_id = Uuid::new_v4().to_string();
        let response = app
            .clone()
            .oneshot(multipart(&[
                ("image", bytes),
                ("store_id", store_id.as_bytes()),
                ("purpose", b"checkout"),
            ]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let uploaded = json(response).await;
        assert_eq!(uploaded["content_type"], mime); // Ignore caller's misleading Content-Type.
        assert_eq!(uploaded["byte_size"], bytes.len());
        assert_eq!(uploaded.as_object().unwrap().len(), 7);
        assert_eq!(uploaded["purpose"], "checkout");
        let id: Uuid = uploaded["id"].as_str().unwrap().parse().unwrap();
        let key = uploaded["object_key"].as_str().unwrap();
        assert_eq!(
            key,
            format!("images/{}/{id}.{ext}", Utc::now().format("%Y/%m"))
        );
        assert_eq!(objects.objects.lock().unwrap()[key], bytes);
        assert_eq!(rows.rows.lock().unwrap()[&id].1, Some(Uuid::nil()));
        let expires: chrono::DateTime<Utc> = uploaded["url_expires_at"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((expires - Utc::now()).num_seconds() >= 898);
        let response = app
            .oneshot(
                Request::get(format!("/v1/images/{id}"))
                    .header("authorization", test_bearer())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let fetched = json(response).await;
        assert_eq!(fetched["object_key"], key);
        assert_eq!(fetched["purpose"], "checkout");
        assert_ne!(fetched["url"], uploaded["url"]);
    }
}
#[tokio::test]
async fn invalid_multipart_uuid_fields_empty_and_unsupported_images() {
    let (state, _, _) = setup();
    let app = router(state);
    for fields in [
        vec![],
        vec![("wrong", PNG)],
        vec![("image", b"".as_slice())],
        vec![("image", PNG), ("image", PNG)],
        vec![("image", PNG), ("purpose", b"bogus".as_slice())],
        vec![("image", PNG), ("purpose", b"crop".as_slice())],
        vec![("image", PNG), ("purpose", b"".as_slice())],
        vec![("image", PNG), ("purpose", b"other"), ("purpose", b"other")],
    ] {
        let response = app.clone().oneshot(multipart(&fields)).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(response).await["code"], "validation_failed");
    }
    for request in [
        Request::post("/v1/images")
            .header("authorization", test_bearer())
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/images")
            .header("authorization", test_bearer())
            .header("content-type", "multipart/form-data; boundary=test")
            .body(Body::from("broken"))
            .unwrap(),
        Request::get("/v1/images/invalid")
            .header("authorization", test_bearer())
            .body(Body::empty())
            .unwrap(),
    ] {
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
    for bytes in [
        b"GIF89a".as_slice(),
        b"RIFF1234WAVE".as_slice(),
        b"\x89PNG".as_slice(),
    ] {
        assert_eq!(
            app.clone()
                .oneshot(multipart(&[("image", bytes)]))
                .await
                .unwrap()
                .status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }
}
#[tokio::test]
async fn exactly_ten_mib_is_accepted_and_larger_bodies_are_413() {
    let (state, _, _) = setup();
    let app = router(state);
    let mut bytes = vec![0; MAX_UPLOAD_BYTES];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    assert_eq!(
        app.clone()
            .oneshot(multipart(&[("image", &bytes)]))
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    bytes.push(0);
    assert_eq!(
        app.clone()
            .oneshot(multipart(&[("image", &bytes)]))
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    bytes.resize(MAX_IMAGE_REQUEST_BYTES + 1, 0);
    assert_eq!(
        app.oneshot(multipart(&[("image", &bytes)]))
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
#[tokio::test]
async fn unknown_is_404_and_unconfigured_routes_are_503() {
    let (state, _, _) = setup();
    let request = || {
        Request::get(format!("/v1/images/{}", Uuid::new_v4()))
            .header("authorization", test_bearer())
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        router(state).oneshot(request()).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    for request in [request(), multipart(&[("image", PNG)])] {
        assert_eq!(
            router(test_state())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
#[tokio::test]
async fn insert_failure_deletes_the_uploaded_object() {
    let (state, objects, rows) = setup();
    rows.fail_insert.store(true, Ordering::Relaxed);
    let response = router(state)
        .oneshot(multipart(&[("image", PNG)]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(rows.rows.lock().unwrap().is_empty());
    assert!(objects.objects.lock().unwrap().is_empty());
    assert_eq!(objects.deleted.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn storage_failures_are_502_and_readiness_names_storage() {
    let (state, objects, rows) = setup();
    objects.fail.store(true, Ordering::Relaxed);
    let app = router(state);
    assert_eq!(
        app.clone()
            .oneshot(multipart(&[("image", PNG)]))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert!(rows.rows.lock().unwrap().is_empty());
    let response = app
        .oneshot(
            Request::get("/readyz")
                .header("authorization", test_bearer())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(response).await;
    assert_eq!(body["storage"], "unavailable");
    assert!(
        body["dependencies"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("storage"))
    );
    let response = router(test_state())
        .oneshot(
            Request::get("/readyz")
                .header("authorization", test_bearer())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = json(response).await;
    assert_eq!(body["storage"], "not configured");
    assert!(
        !body["dependencies"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("storage"))
    );
}
#[tokio::test]
async fn purpose_defaults_to_other() {
    let (state, _, _) = setup();
    let response = router(state)
        .oneshot(multipart(&[("image", PNG)]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(json(response).await["purpose"], "other");
}

#[tokio::test]
async fn bearer_required_and_other_store_cannot_fetch() {
    let (state, _, _) = setup();
    let app = router(state.clone());
    let mut request = multipart(&[("image", PNG)]);
    request.headers_mut().remove("authorization");
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = app
        .clone()
        .oneshot(multipart(&[
            ("image", PNG),
            ("store_id", b"untrusted-client-value"),
        ]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let uploaded = json(response).await;
    let request = Request::get(format!("/v1/images/{}", uploaded["id"].as_str().unwrap()))
        .header("authorization", "Bearer foreign")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.oneshot(request).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
}
