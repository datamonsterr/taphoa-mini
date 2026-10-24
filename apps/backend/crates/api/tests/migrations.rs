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
    "product_prototypes",
    "index_jobs",
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
    "stock_movements",
    "receipts",
    "receipt_lines",
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

#[tokio::test]
#[ignore = "real Postgres required"]
async fn quick_enroll_schema_and_constraints() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();

    let store: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO stores(name, recovery_code_hash) VALUES ('qe','x') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(store_id, display_name, role) VALUES ($1,'lead','lead') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    let product: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO products(id, store_id, price, request_hash, created_by) \
         VALUES (gen_random_uuid(), $1, 1000, 'hash', $2) RETURNING id",
    )
    .bind(store)
    .bind(member)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    // Check products.index_status default is 'ready'
    let index_status: String =
        sqlx::query_scalar("SELECT index_status FROM products WHERE id = $1")
            .bind(product)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(index_status, "ready");

    // Check products.index_status CHECK constraint rejects invalid values
    sqlx::query("SAVEPOINT sp1")
        .execute(&mut *tx)
        .await
        .unwrap();
    let bad_status = sqlx::query("UPDATE products SET index_status = 'invalid' WHERE id = $1")
        .bind(product)
        .execute(&mut *tx)
        .await;
    assert!(
        bad_status.is_err(),
        "index_status check should reject invalid values"
    );
    sqlx::query("ROLLBACK TO SAVEPOINT sp1")
        .execute(&mut *tx)
        .await
        .unwrap();

    let img1: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO images(id, store_id, object_key, content_type, byte_size) \
         VALUES (gen_random_uuid(), $1, 'k1', 'image/jpeg', 100) RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    let img2: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO images(id, store_id, object_key, content_type, byte_size) \
         VALUES (gen_random_uuid(), $1, 'k2', 'image/jpeg', 100) RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    let cutout: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO images(id, store_id, object_key, content_type, byte_size, purpose) \
         VALUES (gen_random_uuid(), $1, 'cutout1', 'image/png', 100, 'crop') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    // product_images position 7 accepted with cutout_image_id and bbox
    let pos7 = sqlx::query(
        "INSERT INTO product_images(product_id, image_id, position, cutout_image_id, bbox) \
         VALUES ($1, $2, 7, $3, $4)",
    )
    .bind(product)
    .bind(img1)
    .bind(cutout)
    .bind(&[10.0_f32, 20.0, 100.0, 200.0][..])
    .execute(&mut *tx)
    .await;
    assert!(pos7.is_ok(), "position 7 should be accepted: {pos7:?}");

    // product_images position 8 rejected
    sqlx::query("SAVEPOINT sp2")
        .execute(&mut *tx)
        .await
        .unwrap();
    let pos8 = sqlx::query(
        "INSERT INTO product_images(product_id, image_id, position) VALUES ($1, $2, 8)",
    )
    .bind(product)
    .bind(img2)
    .execute(&mut *tx)
    .await;
    assert!(pos8.is_err(), "position 8 should be rejected");
    sqlx::query("ROLLBACK TO SAVEPOINT sp2")
        .execute(&mut *tx)
        .await
        .unwrap();

    // product_embeddings.kind defaults to 'crop'
    let emb_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO product_embeddings(store_id, product_id, image_id, model, embedding) \
         VALUES ($1, $2, $3, 'test-model', array_fill(0.0::real, ARRAY[384])::vector) RETURNING id",
    )
    .bind(store)
    .bind(product)
    .bind(img1)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    let kind: String = sqlx::query_scalar("SELECT kind FROM product_embeddings WHERE id = $1")
        .bind(emb_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(kind, "crop");

    // product_embeddings with kind 'cutout' can also be inserted for same (store, product, image, model)
    let emb_cutout = sqlx::query(
        "INSERT INTO product_embeddings(store_id, product_id, image_id, model, kind, embedding) \
         VALUES ($1, $2, $3, 'test-model', 'cutout', array_fill(0.1::real, ARRAY[384])::vector)",
    )
    .bind(store)
    .bind(product)
    .bind(img1)
    .execute(&mut *tx)
    .await;
    assert!(
        emb_cutout.is_ok(),
        "same image with kind 'cutout' should be accepted: {emb_cutout:?}"
    );

    // duplicate (store, product, image, model, kind) is rejected by unique index
    sqlx::query("SAVEPOINT sp3")
        .execute(&mut *tx)
        .await
        .unwrap();
    let emb_dup = sqlx::query(
        "INSERT INTO product_embeddings(store_id, product_id, image_id, model, kind, embedding) \
         VALUES ($1, $2, $3, 'test-model', 'cutout', array_fill(0.2::real, ARRAY[384])::vector)",
    )
    .bind(store)
    .bind(product)
    .bind(img1)
    .execute(&mut *tx)
    .await;
    assert!(
        emb_dup.is_err(),
        "duplicate (store, product, image, model, kind) should violate unique index"
    );
    sqlx::query("ROLLBACK TO SAVEPOINT sp3")
        .execute(&mut *tx)
        .await
        .unwrap();

    // product_prototypes and index_jobs can be inserted
    let proto = sqlx::query(
        "INSERT INTO product_prototypes(store_id, product_id, model, embedding, reference_count) \
         VALUES ($1, $2, 'test-model', array_fill(0.0::real, ARRAY[384])::vector, 3)",
    )
    .bind(store)
    .bind(product)
    .execute(&mut *tx)
    .await;
    assert!(
        proto.is_ok(),
        "inserting product_prototypes should succeed: {proto:?}"
    );

    let job = sqlx::query("INSERT INTO index_jobs(store_id, product_id) VALUES ($1, $2)")
        .bind(store)
        .bind(product)
        .execute(&mut *tx)
        .await;
    assert!(job.is_ok(), "inserting index_jobs should succeed: {job:?}");
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn stock_receipts_columns_and_checks() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO stores(name,recovery_code_hash) VALUES ('stock','x') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(store_id,display_name,role) VALUES ($1,'Lead','lead') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let product: uuid::Uuid = sqlx::query_scalar("INSERT INTO products(id,store_id,price,request_hash,created_by,stock_quantity,low_stock_threshold) VALUES (gen_random_uuid(),$1,1,'hash',$2,-2,0) RETURNING id").bind(store).bind(member).fetch_one(&mut *tx).await.unwrap();
    let threshold: i32 = sqlx::query_scalar("SELECT low_stock_threshold FROM stores WHERE id=$1")
        .bind(store)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(threshold, 5);
    for statement in [
        "UPDATE stores SET low_stock_threshold=-1 WHERE id=$1",
        "UPDATE stores SET low_stock_threshold=100001 WHERE id=$1",
        "UPDATE products SET low_stock_threshold=-1 WHERE store_id=$1",
        "UPDATE products SET low_stock_threshold=100001 WHERE store_id=$1",
        "INSERT INTO stock_movements(store_id,product_id,delta,quantity_after,reason) VALUES ($1,$2,1,1,'bad')",
        "INSERT INTO stock_movements(store_id,product_id,delta,quantity_after,reason,note) VALUES ($1,$2,1,1,'adjustment',repeat('a',201))",
    ] {
        sqlx::query("SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut q = sqlx::query(statement).bind(store);
        if statement.contains("$2") {
            q = q.bind(product);
        }
        let e = q.execute(&mut *tx).await.unwrap_err();
        assert_eq!(
            e.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        sqlx::query("ROLLBACK TO SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let image: uuid::Uuid=sqlx::query_scalar("INSERT INTO images(id,store_id,object_key,content_type,byte_size) VALUES(gen_random_uuid(),$1,'stock-test','image/jpeg',1) RETURNING id").bind(store).fetch_one(&mut *tx).await.unwrap();
    let receipt = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO receipts(id,store_id,member_id,image_id,ocr_text,parser,request_hash) VALUES($1,$2,$3,$4,'text','fallback','hash')").bind(receipt).bind(store).bind(member).bind(image).execute(&mut *tx).await.unwrap();
    for statement in [
        "UPDATE receipts SET status='bad' WHERE id=$1",
        "UPDATE receipts SET parser='bad' WHERE id=$1",
        "INSERT INTO receipt_lines(receipt_id,store_id,position,raw_text,product_name,quantity,cost) SELECT id,store_id,0,'x','x',0,1 FROM receipts WHERE id=$1",
        "INSERT INTO receipt_lines(receipt_id,store_id,position,raw_text,product_name,quantity,cost) SELECT id,store_id,0,'x','x',1,-1 FROM receipts WHERE id=$1",
    ] {
        sqlx::query("SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
        let e = sqlx::query(statement)
            .bind(receipt)
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert_eq!(
            e.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        sqlx::query("ROLLBACK TO SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
}
