//! Additional report semantics not covered by the provided contract suite.
mod common;
use axum::http::StatusCode;
use common::world::{World, sale_body};
use serde_json::json;
use uuid::Uuid;

const DAY: &str = "2026-03-05";
const AT: &str = "2026-03-05T23:30:00+07:00";

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn base_units_expense_only_buckets_and_exports() {
    let w = World::new().await;
    let product = w.product("Thùng", 10000, Some(300)).await;
    let unit: Uuid = sqlx::query_scalar("INSERT INTO product_units (id,store_id,product_id,name,quantity_in_base,price) VALUES (gen_random_uuid(),$1,$2,'thùng',24,10000) RETURNING id")
        .bind(w.store_id).bind(product).fetch_one(w.pool()).await.unwrap();
    let mut body = sale_body(Uuid::now_v7(), AT, "transfer", &[(product, 2, 10000)]);
    body["lines"][0]["unit_id"] = json!(unit);
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body,
        StatusCode::CREATED,
    )
    .await;
    let top = w
        .checked(
            "GET",
            &format!("/v1/reports/top-products?from={DAY}&to={DAY}"),
            "/v1/reports/top-products",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(top["items"][0]["quantity"], 48);
    assert_eq!(top["items"][0]["gross_margin"], 5600);
    let expense = json!({"id":Uuid::now_v7(),"spent_at":"2026-03-06T00:01:00+07:00","amount":500,"category":"khac","paid_with":"other"});
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.lead,
        expense,
        StatusCode::CREATED,
    )
    .await;
    let summary = w
        .checked(
            "GET",
            "/v1/reports/summary?from=2026-03-05&to=2026-03-06&granularity=week",
            "/v1/reports/summary",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        summary["buckets"][0],
        json!({"start":"2026-03-05","end":"2026-03-06","revenue":20000,"sales_count":1,"expenses":500,"net":19500})
    );
    let daily = w
        .checked(
            "GET",
            "/v1/reports/summary?from=2026-03-06&to=2026-03-06",
            "/v1/reports/summary",
            &w.seller,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(daily["buckets"][0]["net"], -500);
    let voided = w
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            sale_body(Uuid::now_v7(), AT, "transfer", &[(product, 1, 10000)]),
            StatusCode::CREATED,
        )
        .await;
    w.checked(
        "POST",
        &format!("/v1/sales/{}/void", voided["id"].as_str().unwrap()),
        "/v1/sales/{saleId}/void",
        &w.lead,
        json!({"reason":"returned"}),
        StatusCode::OK,
    )
    .await;
    sqlx::query("UPDATE members SET display_name=$2 WHERE id=$1")
        .bind(w.seller_id)
        .bind("A, \"B\"")
        .execute(w.pool())
        .await
        .unwrap();
    let export = w
        .call(
            "GET",
            &format!("/v1/exports/transactions?from={DAY}&to={DAY}&format=csv"),
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(export.status, StatusCode::OK);
    let csv = String::from_utf8(export.raw).unwrap();
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("23:30:00"), "{csv}");
    assert!(csv.contains("voided"), "{csv}");
    assert!(csv.contains("\"A, \"\"B\"\"\""), "{csv}");
    assert!(!csv.contains("expense"), "date filter: {csv}");
    let negative = w
        .call(
            "PUT",
            &format!("/v1/day-closes/{DAY}"),
            &w.lead,
            json!({"counted_cash":0,"opening_float":-1}),
        )
        .await;
    assert_eq!(negative.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn recognition_top_three_unknown_and_distinct_scan_median() {
    let w = World::new().await;
    let p = w.product("Confirmed", 1000, None).await;
    let other = w.product("Suggested", 1000, None).await;
    let (scan1, d1) = w.scan_fixture().await;
    let (scan2, d4) = w.scan_fixture().await;
    sqlx::query("UPDATE scans SET timings=jsonb_build_object('total',CASE WHEN id=$2 THEN 10 ELSE 110 END) WHERE store_id=$1")
        .bind(w.store_id).bind(scan1).execute(w.pool()).await.unwrap();
    let mut detections = vec![d1];
    for position in [1_i16, 2] {
        let d: Uuid = sqlx::query_scalar("INSERT INTO detections (store_id,scan_id,position,bbox,score,area,match,candidates) VALUES ($1,$2,$3,'{0,0,1,1}',0.9,100,'matched','[]') RETURNING id")
            .bind(w.store_id).bind(scan1).bind(position).fetch_one(w.pool()).await.unwrap();
        detections.push(d);
    }
    detections.push(d4);
    for (i, d) in detections.iter().enumerate() {
        let candidates = if i < 2 {
            json!([{"product_id":other},{"product_id":p}])
        } else {
            json!([{"product_id":other},{"product_id":other},{"product_id":other},{"product_id":p}])
        };
        sqlx::query("UPDATE detections SET candidates=$2 WHERE id=$1")
            .bind(d)
            .bind(candidates)
            .execute(w.pool())
            .await
            .unwrap();
    }
    let mut body = sale_body(Uuid::now_v7(), AT, "transfer", &[(p, 1, 1000); 4]);
    body["scan_ids"] = json!([scan1, scan2]);
    for (i, d) in detections.iter().enumerate() {
        body["lines"][i]["detection_id"] = json!(d);
        if i < 3 {
            body["lines"][i]["suggested_product_id"] = json!(if i == 0 { p } else { other });
        }
    }
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body,
        StatusCode::CREATED,
    )
    .await;
    let report = w
        .checked(
            "GET",
            &format!("/v1/reports/recognition?from={DAY}&to={DAY}"),
            "/v1/reports/recognition",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(report["detections"], 4);
    assert_eq!(report["confirmed_top1"], 1);
    assert_eq!(report["confirmed_top3"], 2);
    assert_eq!(report["corrected"], 2);
    assert_eq!(report["unknown"], 2);
    assert_eq!(report["top1_rate"], 0.25);
    assert_eq!(report["median_scan_ms"], 60, "each scan counted once");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn oversized_sales_are_rejected_and_max_sales_keep_reports_working() {
    let w = World::new().await;
    let product = w.product("Vang", 1000, None).await;
    // The reproduction of the bug: 2^62 per sale used to be accepted and then break the reports.
    let mut huge = sale_body(Uuid::now_v7(), AT, "transfer", &[(product, 1, 1000)]);
    huge["lines"][0]["unit_price"] = json!(4_611_686_018_427_387_904_i64);
    huge["total"] = json!(4_611_686_018_427_387_904_i64);
    let reply = w.call("POST", "/v1/sales", &w.seller, huge).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
    assert_eq!(reply.body["code"], "validation_failed");
    assert!(reply.body["error"].as_str().unwrap().contains("sale total"));
    let mut pricey = sale_body(
        Uuid::now_v7(),
        AT,
        "transfer",
        &[(product, 1, 2_000_000_000)],
    );
    pricey["lines"][0]["unit_price"] = json!(2_000_000_000_i64);
    let reply = w.call("POST", "/v1/sales", &w.seller, pricey).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
    assert!(reply.body["error"].as_str().unwrap().contains("unit price"));
    // A sale total above the bound is rejected even when each line is within bounds.
    let lines = [(product, 999, 1_000_000_000)].repeat(2);
    let mut over = sale_body(Uuid::now_v7(), AT, "transfer", &lines);
    over["total"] = json!(1_998_000_000_000_i64);
    let reply = w.call("POST", "/v1/sales", &w.seller, over).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
    assert!(reply.body["error"].as_str().unwrap().contains("sale total"));
    // Two sales at the largest accepted size keep both reports correct.
    for _ in 0..2 {
        let body = sale_body(
            Uuid::now_v7(),
            AT,
            "transfer",
            &[(product, 999, 1_000_000_000)],
        );
        w.checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            body,
            StatusCode::CREATED,
        )
        .await;
    }
    let today = w
        .checked(
            "GET",
            &format!("/v1/reports/today?date={DAY}"),
            "/v1/reports/today",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(today["revenue"], 1_998_000_000_000_i64);
    assert_eq!(today["sales_count"], 2);
    let summary = w
        .checked(
            "GET",
            &format!("/v1/reports/summary?from={DAY}&to={DAY}"),
            "/v1/reports/summary",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(summary["buckets"][0]["revenue"], 1_998_000_000_000_i64);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn day_close_rejects_out_of_range_cash_with_422() {
    let w = World::new().await;
    let path = format!("/v1/day-closes/{DAY}");
    for body in [
        json!({"counted_cash": 0, "opening_float": i64::MAX}),
        json!({"counted_cash": i64::MAX}),
        json!({"counted_cash": 1_000_000_000_001_i64}),
    ] {
        let reply = w.call("PUT", &path, &w.lead, body.clone()).await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}: {}",
            reply.body
        );
        assert_eq!(reply.body["code"], "validation_failed");
        assert!(
            reply.body["error"]
                .as_str()
                .unwrap()
                .contains("at most 1000000000000")
        );
    }
    // The bound itself is accepted.
    let ok = w
        .checked(
            "PUT",
            &path,
            "/v1/day-closes/{businessDate}",
            &w.lead,
            json!({"counted_cash": 1_000_000_000_000_i64, "opening_float": 1_000_000_000_000_i64}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(ok["difference"], 0);
}
