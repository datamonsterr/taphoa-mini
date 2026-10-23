//! Additional sales regressions; the provided sales acceptance suite stays unchanged.
mod common;
use axum::http::StatusCode;
use common::world::{World, now_iso, sale_body};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use taphoa_api::storage::{ObjectStore, SignedUrl};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn historical_unit_prices_and_quantity_snapshots() {
    let w = World::new().await;
    let p = w.product("Pack", 1000, None).await;
    let unit = Uuid::now_v7();
    sqlx::query("INSERT INTO product_units(id,store_id,product_id,name,quantity_in_base,price) VALUES($1,$2,$3,'pack',6,9000)")
        .bind(unit).bind(w.store_id).bind(p).execute(w.pool()).await.unwrap();
    for (unit, price, interval) in [
        (None, 2000_i64, "1 day"),
        (Some(unit), 6000, "-1 day"),
        (Some(unit), 9000, "1 day"),
    ] {
        sqlx::query("INSERT INTO price_history(store_id,product_id,unit_id,field,new_value,source,changed_by,changed_at) VALUES($1,$2,$3,'price',$4,'manual',$5,now()+$6::text::interval)")
            .bind(w.store_id).bind(p).bind(unit).bind(price).bind(w.lead_id).bind(interval).execute(w.pool()).await.unwrap();
    }
    sqlx::query("UPDATE products SET price=2000 WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    let id = Uuid::now_v7();
    let mut body = sale_body(id, &now_iso(), "cash", &[(p, 1, 1000), (p, 2, 6000)]);
    body["lines"][1]["unit_id"] = json!(unit);
    let sale = w
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            body.clone(),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(sale["lines"][0]["price_mismatch"], false);
    assert_eq!(sale["lines"][1]["price_mismatch"], false);
    assert_eq!(sale["total"], 13000);
    sqlx::query("UPDATE product_units SET quantity_in_base=12 WHERE id=$1")
        .bind(unit)
        .execute(w.pool())
        .await
        .unwrap();
    let snapshot: i32 = sqlx::query_scalar(
        "SELECT quantity_in_base FROM sale_lines WHERE sale_id=$1 AND unit_id=$2",
    )
    .bind(id)
    .bind(unit)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(snapshot, 6);
    let replay = w.call("POST", "/v1/sales", &w.lead, body.clone()).await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.body["member_id"], w.seller_id.to_string());
    // Even malformed replacement bodies cannot overwrite an accepted sale id.
    let conflict = w
        .call("POST", "/v1/sales", &w.seller, json!({"id":id}))
        .await;
    assert_eq!(conflict.status, StatusCode::CONFLICT);
    assert_eq!(conflict.body["code"], "id_conflict");
    assert_eq!(w.events("sale.created").await, 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn every_reference_is_scoped_to_the_store() {
    let w = World::new().await;
    let other = World::new().await;
    let p = w.product("Local", 1000, None).await;
    let foreign = other.product("Foreign", 1000, None).await;
    let (_, det) = other.scan_fixture().await;
    let unit = Uuid::now_v7();
    sqlx::query("INSERT INTO product_units(id,store_id,product_id,name,quantity_in_base,price) VALUES($1,$2,$3,'pack',6,6000)").bind(unit).bind(other.store_id).bind(foreign).execute(other.pool()).await.unwrap();
    for (field, id) in [
        ("unit_id", unit),
        ("detection_id", det),
        ("suggested_product_id", foreign),
    ] {
        let mut body = sale_body(Uuid::now_v7(), &now_iso(), "transfer", &[(p, 1, 1000)]);
        body["lines"][0][field] = json!(id);
        let r = w.call("POST", "/v1/sales", &w.seller, body).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{field}: {}", r.body);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sales WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(w.events("sale.created").await, 0);
}

struct TestStorage;
#[async_trait::async_trait]
impl ObjectStore for TestStorage {
    async fn put(&self, _: &str, _: &str, _: Vec<u8>) -> anyhow::Result<()> {
        unreachable!()
    }
    async fn delete(&self, _: &str) -> anyhow::Result<()> {
        unreachable!()
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        Ok(SignedUrl {
            url: format!("https://images.example/{key}"),
            expires_at: chrono::Utc::now() + chrono::Duration::from_std(ttl)?,
        })
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn crop_review_link_is_atomic_and_keeps_sale_amounts() {
    let mut w = World::new().await;
    let p = w.product("Linked", 1000, None).await;
    let (scan, det) = w.scan_fixture().await;
    let image: Uuid = sqlx::query_scalar("SELECT image_id FROM scans WHERE id=$1")
        .bind(scan)
        .fetch_one(w.pool())
        .await
        .unwrap();
    let embedding = format!("[1,{}]", ["0"; 383].join(","));
    sqlx::query("UPDATE detections SET crop_image_id=$2,embedding=$3::text::vector WHERE id=$1")
        .bind(det)
        .bind(image)
        .bind(embedding)
        .execute(w.pool())
        .await
        .unwrap();
    w.state.storage = Some(Arc::new(TestStorage));
    w.app = taphoa_api::router(w.state.clone());
    let id = Uuid::now_v7();
    let a = Uuid::now_v7();
    let b = Uuid::now_v7();
    let body = json!({"id":id,"sold_at":now_iso(),"payment_method":"transfer","total":1200,"lines":[
        {"id":a,"source":"manual","quantity":1,"unit_price":700,"detection_id":det},
        {"id":b,"source":"manual","quantity":1,"unit_price":500}
    ]});
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body,
        StatusCode::CREATED,
    )
    .await;
    let first = w
        .checked(
            "GET",
            "/v1/review/manual-lines?limit=1",
            "/v1/review/manual-lines",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = w
        .checked(
            "GET",
            &format!("/v1/review/manual-lines?limit=1&cursor={cursor}"),
            "/v1/review/manual-lines",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_ne!(first["items"][0]["line_id"], second["items"][0]["line_id"]);
    assert!(second["next_cursor"].is_null());
    let queue = w
        .checked(
            "GET",
            "/v1/review/manual-lines",
            "/v1/review/manual-lines",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    let crop = queue["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["line_id"] == a.to_string())
        .unwrap();
    assert_eq!(crop["crop_image"]["id"], image.to_string());
    assert!(
        crop["crop_image"]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://images.example/")
    );
    let foreign = World::new().await;
    let q = foreign.product("Foreign", 1000, None).await;
    let path = format!("/v1/review/manual-lines/{a}/resolve");
    assert_eq!(
        w.call(
            "POST",
            &path,
            &w.lead,
            json!({"action":"link","product_id":q})
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let (r1, r2) = tokio::join!(
        w.call(
            "POST",
            &path,
            &w.lead,
            json!({"action":"link","product_id":p})
        ),
        w.call(
            "POST",
            &path,
            &w.lead,
            json!({"action":"link","product_id":p})
        )
    );
    let mut statuses = [r1.status.as_u16(), r2.status.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    assert_eq!(w.events("review.line_resolved").await, 1);
    let refs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_images WHERE product_id=$1 AND image_id=$2",
    )
    .bind(p)
    .bind(image)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(refs, 1);
    let labels: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_embeddings WHERE product_id=$1 AND detection_id=$2",
    )
    .bind(p)
    .bind(det)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(labels, 1);
    w.checked(
        "POST",
        &format!("/v1/review/manual-lines/{b}/resolve"),
        "/v1/review/manual-lines/{lineId}/resolve",
        &w.lead,
        json!({"action":"enrolled","product_id":p}),
        StatusCode::OK,
    )
    .await;
    let after = w
        .call("GET", &format!("/v1/sales/{id}"), &w.seller, json!(null))
        .await;
    assert_eq!(after.body["total"], 1200);
    assert!(after.body["lines"][0]["product_id"].is_null());
}
