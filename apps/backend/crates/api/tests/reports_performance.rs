//! Opt-in report latency and query-plan evidence against the running services.
mod common;

use axum::http::StatusCode;
use common::world::World;
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL; seeds 20010 sales"]
async fn reports_p95_under_100ms_at_twenty_thousand_sales() {
    let w = World::new().await;
    sqlx::query(r#"
        INSERT INTO sales (id,store_id,member_id,code,sold_at,business_date,payment_method,total,request_hash)
        SELECT gen_random_uuid(),$1,$2,'PERF'||n,
            ('2026-03-01'::date+(n%30)::int)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh',
            '2026-03-01'::date+(n%30)::int,
            CASE WHEN n%2=0 THEN 'cash' ELSE 'transfer' END,1000,'\x00'
        FROM generate_series(1,20010) n
    "#).bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    // Refresh statistics before measuring; don't force the planner to choose an index.
    sqlx::query("ANALYZE sales")
        .execute(w.pool())
        .await
        .unwrap();
    let plan: Vec<(String,)> = sqlx::query_as(
        r#"
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT COALESCE(sum(total),0),count(*),
            sum(total) FILTER (WHERE payment_method='cash'),
            sum(total) FILTER (WHERE payment_method='transfer')
        FROM sales WHERE store_id=$1 AND business_date='2026-03-30' AND status='completed'
    "#,
    )
    .bind(w.store_id)
    .fetch_all(w.pool())
    .await
    .unwrap();
    let plan = plan.into_iter().map(|r| r.0).collect::<Vec<_>>().join("\n");
    println!("daily completed-sales aggregate EXPLAIN:\n{plan}");
    assert!(
        plan.contains("sales_store_date"),
        "store/date index missing: {plan}"
    );
    let mut results = Vec::new();
    for path in [
        "/v1/reports/today?date=2026-03-30",
        "/v1/reports/summary?from=2026-03-01&to=2026-03-30&granularity=day",
    ] {
        // Warm pool, prepared statements and service connections before the measured calls.
        let warm = w.call("GET", path, &w.lead, json!(null)).await;
        assert_eq!(warm.status, StatusCode::OK, "{}", warm.body);
        if path.contains("today") {
            assert_eq!(warm.body["revenue"], 667000);
            assert_eq!(warm.body["sales_count"], 667);
        } else {
            assert_eq!(warm.body["buckets"].as_array().unwrap().len(), 30);
        }
        let mut elapsed = Vec::new();
        for _ in 0..20 {
            let start = Instant::now();
            let reply = w.call("GET", path, &w.lead, json!(null)).await;
            elapsed.push(start.elapsed());
            assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        }
        elapsed.sort();
        // Nearest-rank p95: ceil(20 * .95) is the 19th ordered observation.
        let p95 = elapsed[18];
        println!(
            "{path}: n=20 p95={:.3}ms max={:.3}ms",
            p95.as_secs_f64() * 1000.,
            elapsed[19].as_secs_f64() * 1000.
        );
        results.push((path, p95));
    }
    // Delete this test's store and all seeded rows; leave the running services intact.
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    for (path, p95) in results {
        assert!(p95 < Duration::from_millis(100), "{path} p95={p95:?}");
    }
}
