#![allow(dead_code)]
//! E4 integration-test world: a real store with a Lead and a Seller over the real router.
use super::Contract;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use taphoa_api::{AppState, config::Config, router};
use tower::ServiceExt;
use uuid::Uuid;

pub struct World {
    pub app: Router,
    pub state: AppState,
    pub store_id: Uuid,
    pub lead_id: Uuid,
    pub lead: String,
    pub seller_id: Uuid,
    pub seller: String,
}
pub struct Reply {
    pub status: StatusCode,
    pub body: Value,
    pub headers: axum::http::HeaderMap,
    pub raw: Vec<u8>,
}

async fn app() -> (Router, AppState) {
    let config = Config::from_lookup(|key| match key {
        "JWT_SECRET" => Some("e4-test-secret-at-least-32-bytes-long".into()),
        // Tests create many stores/members from one peer address.
        "RATE_LIMIT_STORE_CREATE_PER_HOUR" | "RATE_LIMIT_JOIN_PER_HOUR" => Some("1000000".into()),
        _ => std::env::var(key).ok(),
    })
    .unwrap();
    let state = AppState::connect_with_config(&config, None).await.unwrap();
    (router(state.clone()), state)
}
pub async fn send(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> Reply {
    let content_type = if method == "PATCH" {
        "application/merge-patch+json"
    } else {
        "application/json"
    };
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", content_type)
        .header("x-forwarded-for", format!("test-{}", Uuid::new_v4()));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let raw = to_bytes(response.into_body(), 8 << 20)
        .await
        .unwrap()
        .to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Reply {
        status,
        body,
        headers,
        raw,
    }
}
fn device() -> Value {
    json!({"name":"counter","platform":"web","app_version":"1.0"})
}
impl World {
    pub async fn new() -> Self {
        let (app, state) = app().await;
        let lead = send(
            &app,
            "POST",
            "/v1/stores",
            None,
            json!({"store_name":"Tạp hóa E4","display_name":"Lead","device":device()}),
        )
        .await;
        assert_eq!(lead.status, StatusCode::CREATED, "{}", lead.body);
        let token = lead.body["access_token"].as_str().unwrap().to_string();
        let invite = send(&app, "POST", "/v1/invites", Some(&token), json!({})).await;
        let seller = send(
            &app,
            "POST",
            "/v1/auth/join",
            None,
            json!({"invite_token":invite.body["token"],"display_name":"Seller","device":device()}),
        )
        .await;
        assert_eq!(seller.status, StatusCode::CREATED, "{}", seller.body);
        Self {
            app,
            state,
            store_id: lead.body["store"]["id"].as_str().unwrap().parse().unwrap(),
            lead_id: lead.body["member"]["id"].as_str().unwrap().parse().unwrap(),
            lead: token,
            seller_id: seller.body["member"]["id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            seller: seller.body["access_token"].as_str().unwrap().to_string(),
        }
    }
    pub fn pool(&self) -> &sqlx::PgPool {
        self.state.postgres.as_ref().unwrap()
    }
    pub async fn call(&self, method: &str, path: &str, token: &str, body: Value) -> Reply {
        send(&self.app, method, path, Some(token), body).await
    }
    /// Call, assert `expected`, and validate JSON bodies against docs/api/openapi.yaml.
    pub async fn checked(
        &self,
        method: &str,
        path: &str,
        template: &str,
        token: &str,
        body: Value,
        expected: StatusCode,
    ) -> Value {
        let reply = self.call(method, path, token, body).await;
        assert_eq!(reply.status, expected, "{method} {path}: {}", reply.body);
        if expected != StatusCode::NO_CONTENT && expected.is_success() {
            Contract::load().assert_conforms(
                template,
                &method.to_lowercase(),
                expected,
                &reply.body,
            );
        }
        reply.body
    }
    /// Insert a catalog product directly (E3 owns the catalog API).
    pub async fn product(&self, name: &str, price: i64, cost: Option<i64>) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO products (id,store_id,name,price,cost_price,request_hash,created_by) VALUES ($1,$2,$3,$4,$5,'\\x00',$6)")
            .bind(id).bind(self.store_id).bind(name).bind(price).bind(cost).bind(self.lead_id)
            .execute(self.pool()).await.unwrap();
        // price_history lets price_mismatch be evaluated at sold_at.
        sqlx::query("INSERT INTO price_history (store_id,product_id,field,old_value,new_value,source,changed_by,changed_at) VALUES ($1,$2,'price',NULL,$3,'manual',$4,now()-interval '30 days')")
            .bind(self.store_id).bind(id).bind(price).bind(self.lead_id).execute(self.pool()).await.unwrap();
        id
    }
    /// A checkout scan with one unknown detection (E2 owns the recognition API).
    pub async fn scan_fixture(&self) -> (Uuid, Uuid) {
        let image = Uuid::now_v7();
        sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose) VALUES ($1,$2,$3,'image/jpeg',10,'checkout')")
            .bind(image).bind(self.store_id).bind(format!("images/test/{image}.jpg")).execute(self.pool()).await.unwrap();
        let scan: Uuid = sqlx::query_scalar("INSERT INTO scans (store_id,image_id,member_id,mode,purpose,segmenter,embedder,catalog_version,timings) VALUES ($1,$2,$3,'multi','checkout','fake','fake',0,'{}') RETURNING id")
            .bind(self.store_id).bind(image).bind(self.seller_id).fetch_one(self.pool()).await.unwrap();
        let det: Uuid = sqlx::query_scalar("INSERT INTO detections (store_id,scan_id,position,bbox,score,area,match,candidates) VALUES ($1,$2,0,'{0,0,1,1}',0.9,100,'unknown','[]') RETURNING id")
            .bind(self.store_id).bind(scan).fetch_one(self.pool()).await.unwrap();
        (scan, det)
    }
    pub async fn events(&self, typ: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE store_id=$1 AND type=$2")
            .bind(self.store_id)
            .bind(typ)
            .fetch_one(self.pool())
            .await
            .unwrap()
    }
    pub async fn set_margin_threshold(&self, pct: f64) {
        self.checked(
            "PATCH",
            "/v1/store",
            "/v1/store",
            &self.lead,
            json!({"margin_threshold_pct":pct}),
            StatusCode::OK,
        )
        .await;
    }
}
/// A cash/transfer sale body with the given lines `(product_id, qty, unit_price)`.
pub fn sale_body(id: Uuid, sold_at: &str, method: &str, lines: &[(Uuid, i32, i64)]) -> Value {
    let total: i64 = lines.iter().map(|(_, q, p)| *q as i64 * p).sum();
    json!({
        "id": id, "sold_at": sold_at, "payment_method": method, "total": total,
        "lines": lines.iter().map(|(p, q, price)| json!({
            "id": Uuid::now_v7(), "product_id": p, "source": "grid", "quantity": q, "unit_price": price
        })).collect::<Vec<_>>(),
    })
}
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
