//! E4 reports, day close and transactions export against real Postgres and Redis.
mod common;
use axum::http::StatusCode;
use common::world::{World, now_iso, sale_body};
use serde_json::{Value, json};
use uuid::Uuid;

const DAY: &str = "2026-03-05";
const AT: &str = "2026-03-05T10:00:00+07:00";

async fn sell(w: &World, token: &str, method: &str, lines: &[(Uuid, i32, i64)], at: &str) -> Value {
    let mut b = sale_body(Uuid::now_v7(), at, method, lines);
    if method == "cash" {
        b["cash_received"] = b["total"].clone();
    }
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        token,
        b,
        StatusCode::CREATED,
    )
    .await
}
async fn spend(w: &World, amount: i64, paid_with: &str, at: &str) {
    let b = json!({"id": Uuid::now_v7(), "spent_at": at, "amount": amount, "category": "khac", "paid_with": paid_with});
    w.checked(
        "POST",
        "/v1/expenses",
        "/v1/expenses",
        &w.lead,
        b,
        StatusCode::CREATED,
    )
    .await;
}

/// Day 2026-03-05: cash 2x10000 + 1x5000, transfer 30000, one cash sale 7000 voided,
/// expenses 12000 cash_box + 3000 other, a deleted expense, and a manual line left open.
async fn busy_day(w: &World) -> (Uuid, Uuid) {
    let a = w.product("Coca", 10000, Some(6000)).await;
    let b = w.product("Kẹo", 5000, None).await;
    sell(w, &w.seller, "cash", &[(a, 2, 10000)], AT).await;
    sell(w, &w.lead, "cash", &[(b, 1, 5000)], AT).await;
    sell(w, &w.seller, "transfer", &[(a, 3, 10000)], AT).await;
    let voided = sell(w, &w.seller, "cash", &[(b, 1, 5000), (b, 1, 2000)], AT).await; // 5000@5000 + 2000 mismatch
    w.checked(
        "POST",
        &format!("/v1/sales/{}/void", voided["id"].as_str().unwrap()),
        "/v1/sales/{saleId}/void",
        &w.lead,
        json!({"reason":"trả hàng"}),
        StatusCode::OK,
    )
    .await;
    spend(w, 12_000, "cash_box", AT).await;
    spend(w, 3_000, "other", AT).await;
    let gone = Uuid::now_v7();
    w.checked("POST", "/v1/expenses", "/v1/expenses", &w.lead, json!({"id": gone, "spent_at": AT, "amount": 99_000, "category": "dien", "paid_with": "cash_box"}), StatusCode::CREATED).await;
    w.call(
        "DELETE",
        &format!("/v1/expenses/{gone}"),
        &w.lead,
        json!(null),
    )
    .await;
    (a, b)
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn today_report_figures() {
    let w = World::new().await;
    busy_day(&w).await;
    let r = w
        .checked(
            "GET",
            &format!("/v1/reports/today?date={DAY}"),
            "/v1/reports/today",
            &w.seller,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(r["business_date"], DAY);
    assert_eq!(r["revenue"], 55_000);
    assert_eq!(r["sales_count"], 3);
    assert_eq!(r["voided_count"], 1);
    assert_eq!(r["cash_revenue"], 25_000);
    assert_eq!(r["transfer_revenue"], 30_000);
    assert_eq!(r["expenses"], 15_000);
    assert_eq!(r["net"], 40_000);
    assert_eq!(r["expected_cash"], 25_000 - 12_000);
    assert_eq!(r["manual_lines_open"], 1);
    assert!(r["day_close"].is_null());
    // default date is today in Asia/Ho_Chi_Minh
    let p = w.product("Mới", 1000, None).await;
    sell(&w, &w.seller, "cash", &[(p, 1, 1000)], &now_iso()).await;
    let today = w
        .checked(
            "GET",
            "/v1/reports/today",
            "/v1/reports/today",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(today["revenue"], 1000);
    assert_eq!(
        w.call("GET", "/v1/reports/today?date=nope", &w.lead, json!(null))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let other = World::new().await;
    let empty = other
        .checked(
            "GET",
            &format!("/v1/reports/today?date={DAY}"),
            "/v1/reports/today",
            &other.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(empty["revenue"], 0);
    assert_eq!(empty["sales_count"], 0);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn summary_buckets_and_validation() {
    let w = World::new().await;
    let p = w.product("Mì", 1000, None).await;
    // Mon 2026-03-02 .. Sun 2026-03-08 is one ISO week; 2026-03-09 starts the next.
    for (at, amt) in [
        ("2026-03-02T10:00:00+07:00", 1),
        ("2026-03-08T23:30:00+07:00", 2),
        ("2026-03-09T00:30:00+07:00", 4),
        ("2026-04-01T10:00:00+07:00", 8),
    ] {
        sell(&w, &w.seller, "transfer", &[(p, amt, 1000)], at).await;
    }
    spend(&w, 500, "other", "2026-03-02T11:00:00+07:00").await;
    let q = |g: &str| format!("/v1/reports/summary?from=2026-03-01&to=2026-04-30&granularity={g}");
    let day = w
        .checked(
            "GET",
            &q("day"),
            "/v1/reports/summary",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(day["granularity"], "day");
    let buckets = day["buckets"].as_array().unwrap();
    assert!(buckets.iter().any(|b| b["start"] == "2026-03-02"
        && b["end"] == "2026-03-02"
        && b["revenue"] == 1000
        && b["expenses"] == 500
        && b["net"] == 500
        && b["sales_count"] == 1));
    let starts: Vec<_> = buckets
        .iter()
        .map(|b| b["start"].as_str().unwrap())
        .collect();
    let mut sorted = starts.clone();
    sorted.sort();
    assert_eq!(starts, sorted, "date order");
    let week = w
        .checked(
            "GET",
            &q("week"),
            "/v1/reports/summary",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    let wk = week["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["start"] == "2026-03-02")
        .unwrap()
        .clone();
    assert_eq!(wk["end"], "2026-03-08");
    assert_eq!(wk["revenue"], 3000);
    assert_eq!(wk["sales_count"], 2);
    let month = w
        .checked(
            "GET",
            &q("month"),
            "/v1/reports/summary",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    let m = month["buckets"].as_array().unwrap();
    assert_eq!(m[0]["start"], "2026-03-01");
    assert_eq!(m[0]["end"], "2026-03-31");
    assert_eq!(m[0]["revenue"], 7000);
    assert_eq!(m[1]["revenue"], 8000);
    for bad in [
        "from=2026-04-02&to=2026-04-01",
        "to=2026-04-01",
        "from=2026-04-01&to=2026-04-02&granularity=year",
    ] {
        assert_eq!(
            w.call(
                "GET",
                &format!("/v1/reports/summary?{bad}"),
                &w.lead,
                json!(null)
            )
            .await
            .status,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn top_products_ranking_and_margin() {
    let w = World::new().await;
    let (coca, candy) = busy_day(&w).await;
    let q = |extra: &str| format!("/v1/reports/top-products?from={DAY}&to={DAY}{extra}");
    let r = w
        .checked(
            "GET",
            &q(""),
            "/v1/reports/top-products",
            &w.seller,
            json!(null),
            StatusCode::OK,
        )
        .await;
    let items = r["items"].as_array().unwrap();
    assert_eq!(items[0]["product_id"], coca.to_string());
    assert_eq!(items[0]["quantity"], 5);
    assert_eq!(items[0]["revenue"], 50_000);
    assert_eq!(items[0]["gross_margin"], 50_000 - 5 * 6000);
    assert_eq!(items[1]["product_id"], candy.to_string());
    assert!(items[1]["gross_margin"].is_null(), "cost unknown");
    assert_eq!(items[1]["revenue"], 5000, "voided sales excluded");
    let one = w
        .call("GET", &q("&limit=1&sort=quantity"), &w.lead, json!(null))
        .await;
    assert_eq!(one.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        w.call("GET", &q("&limit=0"), &w.lead, json!(null))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.call("GET", &q("&sort=name"), &w.lead, json!(null))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn recognition_report() {
    let w = World::new().await;
    let p = w.product("Bia", 15000, None).await;
    let q = format!("/v1/reports/recognition?from={DAY}&to={DAY}");
    assert_eq!(
        w.call("GET", &q, &w.seller, json!(null)).await.status,
        StatusCode::FORBIDDEN
    );
    let empty = w
        .checked(
            "GET",
            &q,
            "/v1/reports/recognition",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(empty["detections"], 0);
    // one detection confirmed top-1 (suggested == product), one corrected (suggested differs)
    let (scan, d1) = w.scan_fixture().await;
    let d2: Uuid = sqlx::query_scalar("INSERT INTO detections (store_id,scan_id,position,bbox,score,area,match,candidates) VALUES ($1,$2,1,'{0,0,1,1}',0.9,100,'ambiguous','[]') RETURNING id").bind(w.store_id).bind(scan).fetch_one(w.pool()).await.unwrap();
    let mut b = sale_body(
        Uuid::now_v7(),
        AT,
        "transfer",
        &[(p, 1, 15000), (p, 1, 15000)],
    );
    b["scan_ids"] = json!([scan]);
    b["lines"][0]["detection_id"] = json!(d1);
    b["lines"][0]["suggested_product_id"] = json!(p);
    b["lines"][1]["detection_id"] = json!(d2);
    b["lines"][1]["suggested_product_id"] = json!(Uuid::now_v7());
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        b,
        StatusCode::CREATED,
    )
    .await;
    let r = w
        .checked(
            "GET",
            &q,
            "/v1/reports/recognition",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(r["detections"], 2);
    assert_eq!(r["confirmed_top1"], 1);
    assert_eq!(r["corrected"], 1);
    assert!((r["top1_rate"].as_f64().unwrap() - 0.5).abs() < 1e-9);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn day_close_expected_cash_overwrite_and_late_sales() {
    let w = World::new().await;
    busy_day(&w).await;
    let path = format!("/v1/day-closes/{DAY}");
    assert_eq!(
        w.call("GET", &path, &w.lead, json!(null)).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        w.call("PUT", &path, &w.seller, json!({"counted_cash": 1}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.call("PUT", &path, &w.lead, json!({})).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.call("PUT", &path, &w.lead, json!({"counted_cash": -1}))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    // cash_sales is gross (completed + voided cash sales of the date); cash_refunds are the voided ones,
    // so the voided 7000 nets out: 200000 + 32000 - 7000 - 12000.
    let c = w
        .checked(
            "PUT",
            &path,
            "/v1/day-closes/{businessDate}",
            &w.lead,
            json!({"counted_cash": 200_000, "opening_float": 200_000, "note": "đủ"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(c["cash_sales"], 32_000);
    assert_eq!(c["cash_refunds"], 7_000);
    assert_eq!(c["cash_expenses"], 12_000);
    assert_eq!(c["transfer_revenue"], 30_000);
    assert_eq!(c["expected_cash"], 200_000 + 32_000 - 7_000 - 12_000);
    assert_eq!(c["difference"], 200_000 - 213_000);
    assert_eq!(c["late_sales_count"], 0);
    assert_eq!(w.events("day.closed").await, 1);
    // report embeds the close
    let t = w
        .call(
            "GET",
            &format!("/v1/reports/today?date={DAY}"),
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(t.body["day_close"]["counted_cash"], 200_000);
    // a sale synced after the close is late
    let p = w.product("Muộn", 1000, None).await;
    sell(&w, &w.seller, "cash", &[(p, 1, 1000)], AT).await;
    let g = w
        .checked(
            "GET",
            &path,
            "/v1/day-closes/{businessDate}",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(g["late_sales_count"], 1);
    // re-close overwrites and recomputes
    let c2 = w
        .checked(
            "PUT",
            &path,
            "/v1/day-closes/{businessDate}",
            &w.lead,
            json!({"counted_cash": 214_000, "opening_float": 200_000}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(c2["expected_cash"], 214_000);
    assert_eq!(c2["difference"], 0);
    assert_eq!(w.events("day.closed").await, 2);
    let list = w
        .checked(
            "GET",
            "/v1/day-closes",
            "/v1/day-closes",
            &w.seller,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        w.call(
            "GET",
            "/v1/day-closes?from=2026-04-01",
            &w.lead,
            json!(null)
        )
        .await
        .body["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let other = World::new().await;
    assert_eq!(
        other
            .call("GET", &path, &other.lead, json!(null))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn transactions_export_csv_and_xlsx() {
    let w = World::new().await;
    let p = w.product("Coca", 10000, None).await;
    let s = sell(&w, &w.seller, "cash", &[(p, 2, 10000)], AT).await;
    spend(&w, 12_000, "cash_box", AT).await;
    let q = format!("/v1/exports/transactions?from={DAY}&to={DAY}");
    assert_eq!(
        w.call("GET", &format!("{q}&format=csv"), &w.seller, json!(null))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let csv = w
        .call("GET", &format!("{q}&format=csv"), &w.lead, json!(null))
        .await;
    assert_eq!(csv.status, StatusCode::OK);
    assert!(
        csv.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/csv")
    );
    assert!(
        csv.headers["content-disposition"]
            .to_str()
            .unwrap()
            .contains("attachment")
    );
    let text = String::from_utf8(csv.raw).unwrap();
    assert!(text.contains(s["code"].as_str().unwrap()), "{text}");
    assert!(text.contains("20000") && text.contains("12000"));
    let xlsx = w.call("GET", &q, &w.lead, json!(null)).await;
    assert_eq!(xlsx.status, StatusCode::OK);
    assert_eq!(
        xlsx.headers["content-type"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    assert_eq!(&xlsx.raw[..2], b"PK", "xlsx is a zip");
    assert_eq!(
        w.call(
            "GET",
            "/v1/exports/transactions?from=2026-03-06&to=2026-03-05",
            &w.lead,
            json!(null)
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.call("GET", &format!("{q}&format=pdf"), &w.lead, json!(null))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}
