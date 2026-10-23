//! Real PostgreSQL/Redis contract test for GET /v1/exports/price-list.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use taphoa_api::{AppState, config::Config, router};
use tower::ServiceExt;
use uuid::Uuid;

async fn setup() -> (Router, AppState) {
    let config = Config::from_lookup(|key| match key {
        "JWT_SECRET" => Some("catalog-test-secret-at-least-32-bytes!!".into()),
        k if k.starts_with("RATE_LIMIT_") => Some("1000000".into()),
        _ => std::env::var(key).ok(),
    })
    .unwrap();
    let mut state = AppState::connect_with_config(&config, None).await.unwrap();
    state.rate_limiter = std::sync::Arc::new(taphoa_api::ratelimit::MemoryRateLimiter::default());
    (router(state.clone()), state)
}

async fn create_store(app: &Router) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/stores")
                .header("content-type", "application/json")
                .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()))
                .body(Body::from(
                    json!({
                        "store_name": "Tạp hóa Cô Ba",
                        "display_name": "Cô Ba",
                        "device": {"name":"counter","platform":"web","app_version":"1.0"}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

async fn export(app: &Router, query: &str, token: Option<&str>) -> (StatusCode, String, Vec<u8>) {
    let mut request = Request::get(format!("/v1/exports/price-list{query}"));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = to_bytes(response.into_body(), 8 << 20).await.unwrap();
    (status, content_type, bytes.to_vec())
}

fn pdf_text(bytes: &[u8]) -> String {
    let mut warnings = Vec::new();
    let document =
        printpdf::PdfDocument::parse(bytes, &printpdf::PdfParseOptions::default(), &mut warnings)
            .expect("generated PDF parses");
    document
        .extract_text()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn price_list_exports_pdf_and_png_for_authenticated_store() {
    let (app, state) = setup().await;
    let lead = create_store(&app).await;
    let token = lead["access_token"].as_str().unwrap();
    let store_id: Uuid = lead["store"]["id"].as_str().unwrap().parse().unwrap();
    let member_id: Uuid = lead["member"]["id"].as_str().unwrap().parse().unwrap();
    let pool = state.postgres.as_ref().unwrap();

    let coffee = Uuid::new_v4();
    let bread = Uuid::new_v4();
    let archived = Uuid::new_v4();
    for (id, name, base_unit, price, is_archived) in [
        (coffee, "Cà phê sữa", "ly", 12_000_i64, false),
        (bread, "Bánh mì", "ổ", 5_000_i64, false),
        (archived, "Bia cũ", "lon", 9_000_i64, true),
    ] {
        sqlx::query(
            "INSERT INTO products (id, store_id, name, base_unit, price, archived, request_hash, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(id)
        .bind(store_id)
        .bind(name)
        .bind(base_unit)
        .bind(price)
        .bind(is_archived)
        .bind(vec![0_u8; 32])
        .bind(member_id)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO product_units (id, store_id, product_id, name, quantity_in_base, price)
         VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(Uuid::new_v4())
    .bind(store_id)
    .bind(bread)
    .bind("Thùng")
    .bind(10_i32)
    .bind(45_000_i64)
    .execute(pool)
    .await
    .unwrap();

    let (status, content_type, pdf) = export(&app, "", Some(token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "application/pdf");
    assert!(pdf.starts_with(b"%PDF"), "missing PDF magic bytes");

    let text = pdf_text(&pdf);
    assert!(text.contains("Cà phê sữa"), "PDF text: {text}");
    assert!(text.contains("Bánh mì"), "PDF text: {text}");
    assert!(text.contains("Thùng"), "PDF text: {text}");
    assert!(!text.contains("Bia cũ"), "archived product leaked: {text}");

    let (status, content_type, png) = export(&app, "?format=png", Some(token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "image/png");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    let (status, _, body) = export(&app, "?format=gif", Some(token)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let error: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(error["code"], "validation_failed");

    let (status, _, _) = export(&app, "", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
