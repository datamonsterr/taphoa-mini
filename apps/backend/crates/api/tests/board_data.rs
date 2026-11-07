//! Board API regressions: real router, PostgreSQL and Redis.
mod common;
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use common::world::World;
use serde_json::{Value, json};
use uuid::Uuid;

async fn sale(
    w: &World,
    product: Uuid,
    days: i64,
    quantity: i32,
    size: i32,
    voided: bool,
    customer: Option<Uuid>,
) {
    let id = Uuid::new_v4();
    let sold = Utc::now() - Duration::days(days);
    sqlx::query("INSERT INTO sales(id,store_id,code,member_id,sold_at,business_date,payment_method,total,request_hash,status,voided_at,customer_id,credit_amount) VALUES($1,$2,$3,$4,$5,$6,'cash',100,'hash',$7,$8,$9,$10)")
        .bind(id).bind(w.store_id).bind(id.to_string()).bind(w.lead_id).bind(sold).bind(taphoa_api::time::business_date(sold))
        .bind(if voided { "voided" } else { "completed" }).bind(voided.then_some(Utc::now())).bind(customer).bind(if customer.is_some() { 100_i64 } else { 0 }).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO sale_lines(id,store_id,sale_id,position,product_id,source,quantity,quantity_in_base,unit_price) VALUES($1,$2,$3,0,$4,'grid',$5,$6,100)")
        .bind(Uuid::new_v4()).bind(w.store_id).bind(id).bind(product).bind(quantity).bind(size).execute(w.pool()).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn stock_and_digest_share_scoped_base_unit_sales_rate() {
    let mut w = World::new().await;
    w.state.storage = Some(std::sync::Arc::new(
        taphoa_api::storage::S3Store::new(
            &taphoa_api::storage::StorageConfig::from_env()
                .unwrap()
                .expect("storage env"),
        )
        .await,
    ));
    w.app = taphoa_api::router(w.state.clone());
    let other = World::new().await;
    let p = w.product("Board product", 100, None).await;
    let idle = w.product("No sales", 100, None).await;
    sqlx::query("UPDATE products SET stock_quantity=3 WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    // 28 base units / 14 = 2.0. Include both date boundaries; exclude stale/future/void/foreign sales.
    sale(&w, p, 0, 2, 7, false, None).await;
    sale(&w, p, 13, 14, 1, false, None).await;
    sale(&w, p, 14, 500, 1, false, None).await;
    sale(&w, p, -1, 500, 1, false, None).await;
    sale(&w, p, 1, 500, 1, true, None).await;
    sale(&other, p, 1, 500, 1, false, None).await;
    let image = Uuid::new_v4();
    sqlx::query("INSERT INTO images(id,store_id,object_key,content_type,byte_size) VALUES($1,$2,'board/thumb.jpg','image/jpeg',1)").bind(image).bind(w.store_id).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO product_images(product_id,image_id,position) VALUES($1,$2,0)")
        .bind(p)
        .bind(image)
        .execute(w.pool())
        .await
        .unwrap();
    for token in [&w.lead, &w.seller] {
        let stock = w
            .checked(
                "GET",
                "/v1/stock",
                "/v1/stock",
                token,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        for (id, expected) in [(p, 2.0), (idle, 0.0)] {
            let row = stock["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["product_id"] == id.to_string())
                .unwrap();
            assert_eq!(row["sales_rate"].as_f64(), Some(expected), "{row}");
        }
        let digest = w
            .checked(
                "GET",
                "/v1/assistant/digest",
                "/v1/assistant/digest",
                token,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        let row = digest["restock"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["product_id"] == p.to_string())
            .unwrap();
        assert_eq!(row["sales_rate"].as_f64(), Some(2.0));
        assert_eq!(row["stock_quantity"], 3);
        assert_eq!(row["quantity"], 16);
        assert!(
            row["image_url"]
                .as_str()
                .unwrap()
                .contains("board/thumb.jpg")
        );
        assert!(
            row["image_url"]
                .as_str()
                .unwrap()
                .contains("X-Amz-Signature=")
        );
        let idle_row = digest["restock"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["product_id"] == idle.to_string())
            .unwrap();
        assert_eq!(idle_row["sales_rate"].as_f64(), Some(0.0));
        assert!(idle_row["image_url"].is_null());
        if token == &w.seller {
            assert!(row["unit_cost"].is_null());
        }
    }
    let payload: Value =
        sqlx::query_scalar("SELECT payload FROM assistant_digests WHERE store_id=$1")
            .bind(w.store_id)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert!(
        !payload.to_string().contains("https://"),
        "signed URLs must never be cached"
    );
}

async fn customer(w: &World, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    w.checked(
        "POST",
        "/v1/customers",
        "/v1/customers",
        &w.lead,
        json!({"id":id,"name":name}),
        StatusCode::CREATED,
    )
    .await;
    id
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn customer_activity_uses_completed_sales_and_repayments_only() {
    let w = World::new().await;
    let other = World::new().await;
    let untouched = customer(&w, "Untouched").await;
    let buyer = customer(&w, "Buyer").await;
    let payer = customer(&w, "Settled").await;
    customer(&other, "Foreign").await;
    let p = w.product("Product", 100, None).await;
    sale(&w, p, 3, 1, 1, false, Some(buyer)).await;
    sale(&w, p, 1, 1, 1, true, Some(untouched)).await;
    sqlx::query("INSERT INTO debt_entries(store_id,customer_id,kind,amount,balance_after,member_id,business_date,created_at) VALUES($1,$2,'repayment',-100,0,$3,current_date,$4)")
        .bind(w.store_id).bind(buyer).bind(w.lead_id).bind(Utc::now()-Duration::days(10)).execute(w.pool()).await.unwrap();
    sale(&w, p, 0, 1, 1, true, Some(buyer)).await;
    sale(&w, p, 5, 1, 1, false, Some(payer)).await;
    for (kind, days, amount) in [("repayment", 2, -100_i64), ("adjustment", 0, 100)] {
        sqlx::query("INSERT INTO debt_entries(store_id,customer_id,kind,amount,balance_after,member_id,business_date,created_at) VALUES($1,$2,$3,$4,0,$5,current_date,$6)")
            .bind(w.store_id).bind(payer).bind(kind).bind(amount).bind(w.lead_id).bind(Utc::now()-Duration::days(days)).execute(w.pool()).await.unwrap();
    }
    for token in [&w.lead, &w.seller] {
        let result = w
            .checked(
                "GET",
                "/v1/customers?sort=name",
                "/v1/customers",
                token,
                Value::Null,
                StatusCode::OK,
            )
            .await;
        let rows = result["items"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        for (id, days) in [(untouched, None), (buyer, Some(3)), (payer, Some(2))] {
            let r = rows.iter().find(|r| r["id"] == id.to_string()).unwrap();
            assert!(r.get("last_activity_at").is_some(), "{r}");
            if let Some(days) = days {
                let at =
                    chrono::DateTime::parse_from_rfc3339(r["last_activity_at"].as_str().unwrap())
                        .unwrap();
                assert!(
                    (Utc::now() - at.with_timezone(&Utc) - Duration::days(days))
                        .num_seconds()
                        .abs()
                        < 10
                );
            } else {
                assert!(r["last_activity_at"].is_null());
            }
        }
    }
}
