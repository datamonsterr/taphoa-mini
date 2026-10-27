//! Seeding twice must not change row counts. `DATABASE_URL` required.
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_is_idempotent_and_covers_all_tables() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("SKIP seed integration: set DATABASE_URL");
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    taphoa_api::MIGRATOR.run(&pool).await.unwrap();
    taphoa_api::seed::run(&pool).await.unwrap();
    let first = counts(&pool).await;
    taphoa_api::seed::run(&pool).await.unwrap();
    assert_eq!(first, counts(&pool).await, "second seed changed row counts");
    for (table, n) in &first {
        assert!(*n > 0, "seed left {table} empty");
    }
}

async fn counts(pool: &sqlx::PgPool) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for table in [
        "stores",
        "members",
        "invites",
        "images",
        "categories",
        "products",
        "product_units",
        "product_images",
        "product_embeddings",
        "price_history",
        "scans",
        "detections",
        "sales",
        "sale_lines",
        "sale_scans",
        "expenses",
        "purchase_lines",
        "margin_alerts",
        "day_closes",
        "change_log",
        "outbox_events",
    ] {
        // Table names above are an audited fixed whitelist.
        let n: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
                .fetch_one(pool)
                .await
                .unwrap();
        out.push((table.to_string(), n));
    }
    out
}
