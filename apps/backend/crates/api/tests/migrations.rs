//! Schema contract for docs/data-model.md section 3. Run with DATABASE_URL set:
//! `cargo test -p taphoa-api --test migrations -- --ignored`.
use sqlx::{PgPool, postgres::PgPoolOptions};

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok().or_else(|| {
        eprintln!("SKIP migrations integration: set DATABASE_URL");
        None
    })?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    taphoa_api::MIGRATOR.run(&pool).await.unwrap();
    Some(pool)
}

const TABLES: &[&str] = &[
    "stores",
    "members",
    "sessions",
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
];

#[tokio::test]
#[ignore = "real Postgres required"]
async fn every_table_exists_and_migrations_are_idempotent() {
    let Some(pool) = pool().await else { return };
    taphoa_api::MIGRATOR.run(&pool).await.unwrap(); // second run is a no-op
    for table in TABLES {
        let found: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("public.{table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(found, "missing table {table}");
    }
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn hnsw_index_and_store_leading_indexes() {
    let Some(pool) = pool().await else { return };
    let def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE indexname='product_embeddings_hnsw'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        def.contains("hnsw") && def.contains("vector_cosine_ops"),
        "{def}"
    );
    // Every store-owned table that handlers query must have an index whose first column is store_id.
    for table in [
        "members",
        "images",
        "categories",
        "products",
        "product_embeddings",
        "scans",
        "sales",
        "sale_lines",
        "expenses",
        "margin_alerts",
        "change_log",
    ] {
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_indexes WHERE tablename=$1 AND indexdef ~ '\\(\\(?store_id\\M'",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(n > 0, "{table} has no index starting with store_id");
    }
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn check_constraints_reject_bad_rows() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO stores(name, recovery_code_hash) VALUES ('t','x') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    // Partial bank account violates bank_all_or_none.
    let err = sqlx::query("UPDATE stores SET bank_bin='970436' WHERE id=$1")
        .bind(store)
        .execute(&mut *tx)
        .await;
    assert!(err.is_err(), "bank_all_or_none not enforced");
    drop(tx); // rollback
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO stores(name, recovery_code_hash) VALUES ('t','x') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let bad_role =
        sqlx::query("INSERT INTO members(store_id, display_name, role) VALUES ($1,'a','admin')")
            .bind(store)
            .execute(&mut *tx)
            .await;
    assert!(bad_role.is_err(), "role CHECK missing");
}
