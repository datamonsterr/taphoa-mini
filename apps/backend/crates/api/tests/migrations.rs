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
    "stock_adjustment_requests",
    "receipts",
    "receipt_lines",
    "assistant_threads",
    "assistant_messages",
    "assistant_actions",
    "assistant_feedback",
    "devices",
    "push_tickets",
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
        "assistant_threads",
        "assistant_messages",
        "assistant_actions",
        "assistant_feedback",
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
    let store: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES ('t') RETURNING id")
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
    let store: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES ('t') RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let bad_role =
        sqlx::query("INSERT INTO members(clerk_user_id,store_id, display_name, role) VALUES ('fixture_' || gen_random_uuid()::text,$1,'a','admin')")
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

    let store: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES ('qe') RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .unwrap();

    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(clerk_user_id,store_id, display_name, role) VALUES ('fixture_' || gen_random_uuid()::text,$1,'lead','lead') RETURNING id",
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
    let store: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES ('stock') RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(clerk_user_id,store_id,display_name,role) VALUES ('fixture_' || gen_random_uuid()::text,$1,'Lead','lead') RETURNING id",
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

#[test]
fn debt_book_migration_uses_reserved_epic_version() {
    let migrations: Vec<_> = taphoa_api::MIGRATOR.iter().collect();
    assert!(
        migrations
            .iter()
            .any(|m| m.version == 901 && m.description == "debt book")
    );
}
#[tokio::test]
#[ignore = "real Postgres required"]
async fn debt_book_schema_checks_and_sales_constraint_replacement() {
    let Some(pool) = pool().await else { return };
    for table in ["customers", "debt_entries"] {
        let found: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(found);
    }
    let check:String=sqlx::query_scalar("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='sales'::regclass AND conname='sales_check1'").fetch_one(&pool).await.unwrap();
    assert!(check.contains("total - credit_amount"), "{check}");
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES('debts') RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(clerk_user_id,store_id,display_name,role) VALUES ('fixture_' || gen_random_uuid()::text,$1,'Lead','lead') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let customer = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO customers(id,store_id,name,request_hash) VALUES($1,$2,'A','hash')")
        .bind(customer)
        .bind(store)
        .execute(&mut *tx)
        .await
        .unwrap();
    for (kind, amount, method) in [
        ("credit_sale", -1, None),
        ("repayment", 1, Some("cash")),
        ("void", 1, None),
        ("adjustment", 0, None),
        ("repayment", -1, Some("card")),
    ] {
        sqlx::query("SAVEPOINT invalid_debt")
            .execute(&mut *tx)
            .await
            .unwrap();
        let error=sqlx::query("INSERT INTO debt_entries(store_id,customer_id,kind,amount,balance_after,method,member_id,business_date) VALUES($1,$2,$3,$4,0,$5,$6,current_date)").bind(store).bind(customer).bind(kind).bind(amount as i64).bind(method).bind(member).execute(&mut *tx).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        sqlx::query("ROLLBACK TO SAVEPOINT invalid_debt")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    // Full and partial credit satisfy the replaced cash check; noncredit rows keep the old behavior.
    for (method, total, credit, cash) in [
        ("credit", 100_i64, 100_i64, None),
        ("cash", 100, 60, Some(40)),
    ] {
        sqlx::query("INSERT INTO sales(id,store_id,code,member_id,sold_at,business_date,payment_method,total,credit_amount,customer_id,cash_received,request_hash) VALUES(gen_random_uuid(),$1,$2,$3,now(),current_date,$2,$4,$5,$6,$7,'hash')").bind(store).bind(method).bind(member).bind(total).bind(credit).bind(customer).bind(cash).execute(&mut *tx).await.unwrap();
    }
}
#[tokio::test]
#[ignore = "real Postgres required"]
async fn migrator_tolerates_missing_versions() {
    let Some(pool) = pool().await else { return };
    // Hold the synthetic row in a transaction so concurrent tests cannot observe it.
    // Rollback also cleans it up if the assertion fails.
    let mut tx = pool.begin().await.unwrap();
    let version = 99990001_i64;
    assert!(!taphoa_api::MIGRATOR.version_exists(version));
    sqlx::query("INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) VALUES ($1, 'X0 T2 missing version regression', true, $2, 0)")
        .bind(version)
        .bind(vec![0_u8; 48])
        .execute(&mut *tx)
        .await
        .unwrap();
    let result = taphoa_api::MIGRATOR.run(&mut *tx).await;
    tx.rollback().await.unwrap();
    assert!(
        result.is_ok(),
        "missing version should be tolerated: {result:?}"
    );
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn assistant_checks_defaults_and_cascades() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO stores(name) VALUES ('assistant') RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(clerk_user_id,store_id,display_name,role) VALUES ('fixture_' || gen_random_uuid()::text,$1,'Lead','lead') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let thread: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO assistant_threads(store_id,member_id) VALUES ($1,$2) RETURNING id",
    )
    .bind(store)
    .bind(member)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let message: uuid::Uuid = sqlx::query_scalar("INSERT INTO assistant_messages(thread_id,store_id,role,content) VALUES ($1,$2,'assistant','Chào') RETURNING id")
        .bind(thread)
        .bind(store)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let (status, attachments, tool_calls, transcript, cards): (
        String,
        serde_json::Value,
        serde_json::Value,
        serde_json::Value,
        serde_json::Value,
    ) = sqlx::query_as(
        "SELECT status,attachments,tool_calls,transcript,cards FROM assistant_messages WHERE id=$1",
    )
    .bind(message)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(status, "complete");
    for value in [attachments, tool_calls, transcript, cards] {
        assert_eq!(value, serde_json::json!([]));
    }
    let action: uuid::Uuid = sqlx::query_scalar("INSERT INTO assistant_actions(store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,expires_at) VALUES ($1,$2,$3,'expense','{}','x',$4,now()) RETURNING id")
        .bind(store)
        .bind(thread)
        .bind(message)
        .bind(member)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let default_status: String =
        sqlx::query_scalar("SELECT status FROM assistant_actions WHERE id=$1")
            .bind(action)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(default_status, "proposed");
    sqlx::query("INSERT INTO assistant_feedback(message_id,member_id,store_id,rating) VALUES ($1,$2,$3,'up')")
        .bind(message)
        .bind(member)
        .bind(store)
        .execute(&mut *tx)
        .await
        .unwrap();
    for statement in [
        "INSERT INTO assistant_messages(thread_id,store_id,role,content) VALUES ($1,$2,'system','x')",
        "INSERT INTO assistant_messages(thread_id,store_id,role,content,status) VALUES ($1,$2,'user','x','done')",
        "UPDATE assistant_actions SET status='confirmed' WHERE store_id=$2",
        "UPDATE assistant_feedback SET rating='neutral' WHERE store_id=$2",
        "INSERT INTO assistant_feedback(message_id,member_id,store_id,rating) VALUES ($3,$4,$2,'down')",
    ] {
        sqlx::query("SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
        let e = sqlx::query(statement)
            .bind(thread)
            .bind(store)
            .bind(message)
            .bind(member)
            .execute(&mut *tx)
            .await
            .unwrap_err();
        // 23514 check violation, 23505 duplicate (message_id, member_id).
        assert!(
            matches!(
                e.as_database_error().unwrap().code().as_deref(),
                Some("23514" | "23505")
            ),
            "{statement}: {e}"
        );
        sqlx::query("ROLLBACK TO SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    // Deleting the thread removes its messages, actions and feedback.
    sqlx::query("DELETE FROM assistant_threads WHERE id=$1")
        .bind(thread)
        .execute(&mut *tx)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM assistant_messages WHERE store_id=$1) \
         + (SELECT count(*) FROM assistant_actions WHERE store_id=$1) \
         + (SELECT count(*) FROM assistant_feedback WHERE store_id=$1)",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn devices_migration_uses_reserved_epic_version() {
    let migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
    assert!(migrations.join("1001_devices.sql").is_file());
    assert!(
        taphoa_api::MIGRATOR
            .iter()
            .any(|migration| migration.version == 1001)
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn devices_schema_constraints_indexes_and_store_cascade() {
    let pool = pool().await.expect("DATABASE_URL required");
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO stores(name,recovery_code_hash) VALUES ('devices','x') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(store_id,display_name,role) VALUES ($1,'lead','lead') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let token = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO devices(token,store_id,member_id,platform,app_version,language) VALUES ($1,$2,$3,'android','1','vi')")
        .bind(&token).bind(store).bind(member).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO push_tickets(store_id,token,business_date,status) VALUES ($1,$2,CURRENT_DATE,'pending_receipt')")
        .bind(store).bind(&token).execute(&mut *tx).await.unwrap();
    for statement in [
        "UPDATE devices SET platform='web' WHERE token=$1",
        "UPDATE devices SET language='fr' WHERE token=$1",
        "UPDATE devices SET app_version='' WHERE token=$1",
        "UPDATE push_tickets SET status='bad' WHERE token=$1",
    ] {
        sqlx::query("SAVEPOINT invalid_device")
            .execute(&mut *tx)
            .await
            .unwrap();
        let error = sqlx::query(statement)
            .bind(&token)
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        sqlx::query("ROLLBACK TO SAVEPOINT invalid_device")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for (table, columns) in [
        ("devices", "(store_id, member_id)"),
        ("push_tickets", "(status, created_at)"),
        ("push_tickets", "(store_id, business_date)"),
    ] {
        let definitions: Vec<String> =
            sqlx::query_scalar("SELECT indexdef FROM pg_indexes WHERE tablename=$1")
                .bind(table)
                .fetch_all(&mut *tx)
                .await
                .unwrap();
        assert!(definitions.iter().any(|s| s.contains(columns)));
    }
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(store)
        .execute(&mut *tx)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM devices WHERE store_id=$1) + (SELECT count(*) FROM push_tickets WHERE store_id=$1)")
        .bind(store).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(left, 0);
}

#[test]
fn assistant_digests_migration_uses_reserved_epic_version() {
    assert!(
        taphoa_api::MIGRATOR
            .iter()
            .any(|m| m.version == 1002 && m.description == "assistant digests")
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn assistant_digest_schema_checks_and_cascades() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let store: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO stores(name,recovery_code_hash) VALUES('digest','x') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let member: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO members(store_id,display_name,role) VALUES($1,'Lead','lead') RETURNING id",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO assistant_digests(store_id,business_date,source,summary_vi,payload) VALUES($1,current_date,'template','Hôm qua chưa có đơn nào.','{}')").bind(store).execute(&mut *tx).await.unwrap();
    let defaults: (bool, bool) = sqlx::query_as("SELECT generated_at IS NOT NULL, pushed_at IS NULL FROM assistant_digests WHERE store_id=$1").bind(store).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(defaults, (true, true));
    sqlx::query("INSERT INTO assistant_digest_reads(store_id,business_date,member_id) VALUES($1,current_date,$2)").bind(store).bind(member).execute(&mut *tx).await.unwrap();
    let read: bool = sqlx::query_scalar(
        "SELECT read_at IS NOT NULL FROM assistant_digest_reads WHERE store_id=$1",
    )
    .bind(store)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert!(read);
    for (statement, code) in [
        (
            "UPDATE assistant_digests SET source='invalid' WHERE store_id=$1",
            "23514",
        ),
        (
            "INSERT INTO assistant_digests(store_id,business_date,source,summary_vi,payload) VALUES($1,current_date,'template','x','{}')",
            "23505",
        ),
        (
            "INSERT INTO assistant_digest_reads(store_id,business_date,member_id) VALUES($1,current_date-1,$2)",
            "23503",
        ),
        (
            "INSERT INTO assistant_digest_reads(store_id,business_date,member_id) VALUES($1,current_date,$2)",
            "23505",
        ),
    ] {
        sqlx::query("SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut query = sqlx::query(statement).bind(store);
        if statement.contains("$2") {
            query = query.bind(member);
        }
        let error = query.execute(&mut *tx).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(code)
        );
        sqlx::query("ROLLBACK TO SAVEPOINT invalid")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM members WHERE id=$1")
        .bind(member)
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM assistant_digest_reads WHERE store_id=$1")
            .bind(store)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(store)
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM assistant_digests WHERE store_id=$1")
        .bind(store)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
