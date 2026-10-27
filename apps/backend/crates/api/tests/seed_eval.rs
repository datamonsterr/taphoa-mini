//! The eval store ("Tạp hóa Cô Ba") against a real Postgres: fixtures, rerun, reset.
//! Database tests need `DATABASE_URL` naming a database the suite may write to. The v1 fixture
//! stores must stay untouched whatever happens to the eval store.
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::process::Command;
use taphoa_api::seed::eval::{self, EvalOptions, EvalStatus};
use uuid::Uuid;

/// Tables with a `store_id`, fingerprinted row by row. `change_log` and `outbox_events` carry
/// database-generated ids and `scans.catalog_version` points into `change_log`, so those three
/// are only counted when comparing a reset against the previous seed.
const CONTENT_TABLES: [&str; 19] = [
    "members",
    "invites",
    "images",
    "categories",
    "products",
    "product_units",
    "product_embeddings",
    "price_history",
    "detections",
    "sales",
    "sale_lines",
    "expenses",
    "purchase_lines",
    "margin_alerts",
    "day_closes",
    "stock_movements",
    "receipts",
    "receipt_lines",
    "stores",
];
const GENERATED_TABLES: [&str; 3] = ["change_log", "outbox_events", "scans"];

/// The database tests share one eval store, so they run one at a time.
static DATABASE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn connect() -> Option<PgPool> {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("SKIP eval seed integration: set DATABASE_URL");
        return None;
    };
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    taphoa_api::MIGRATOR.run(&pool).await.unwrap();
    Some(pool)
}

fn from_clause(table: &str) -> String {
    match table {
        "stores" => "stores t WHERE t.id = ANY($1)".into(),
        "product_images" => {
            "product_images t JOIN products p ON p.id=t.product_id WHERE p.store_id = ANY($1)"
                .into()
        }
        "sale_scans" => {
            "sale_scans t JOIN sales s ON s.id=t.sale_id WHERE s.store_id = ANY($1)".into()
        }
        _ => format!("{table} t WHERE t.store_id = ANY($1)"),
    }
}

async fn count(pool: &PgPool, table: &str, stores: &[Uuid]) -> i64 {
    // Table names come from the fixed lists above.
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM {}",
        from_clause(table)
    )))
    .bind(stores)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn fingerprint(pool: &PgPool, table: &str, stores: &[Uuid]) -> String {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT coalesce(md5(string_agg(h, ',' ORDER BY h)), '') FROM (SELECT md5(to_jsonb(t)::text) h FROM {}) x",
        from_clause(table)
    )))
    .bind(stores)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn all_counts(pool: &PgPool, stores: &[Uuid]) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for table in CONTENT_TABLES
        .iter()
        .chain(&GENERATED_TABLES)
        .chain(&["product_images", "sale_scans"])
    {
        out.push((table.to_string(), count(pool, table, stores).await));
    }
    out
}

async fn fingerprints(pool: &PgPool, stores: &[Uuid]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for table in CONTENT_TABLES
        .iter()
        .chain(&["product_images", "sale_scans"])
    {
        out.push((table.to_string(), fingerprint(pool, table, stores).await));
    }
    out
}

/// Sales totals per business date: the checksum the spec asks for.
async fn daily_checksum(pool: &PgPool, store: Uuid) -> String {
    sqlx::query_scalar("SELECT md5(string_agg(business_date::text||':'||n||':'||total, ',' ORDER BY business_date)) FROM (SELECT business_date, count(*) n, sum(total) total FROM sales WHERE store_id=$1 GROUP BY business_date) d")
        .bind(store)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn scalar(pool: &PgPool, store: Uuid, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(store)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn assert_zero(pool: &PgPool, store: Uuid, what: &str, sql: &'static str) {
    assert_eq!(
        scalar(pool, store, sql).await,
        0,
        "invariant violated: {what}"
    );
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn eval_store_fixtures_rerun_and_reset() {
    let _one_at_a_time = DATABASE.lock().await;
    let Some(pool) = connect().await else { return };

    // The v1 stores exist and must come out byte-identical.
    let v1: Vec<Uuid> = taphoa_api::seed::run(&pool)
        .await
        .unwrap()
        .stores
        .iter()
        .map(|s| s.store_id)
        .collect();
    assert_eq!(v1.len(), 2);
    let v1_before = fingerprints(&pool, &v1).await;
    let v1_counts_before = all_counts(&pool, &v1).await;

    // Start from a known state, whatever earlier runs left behind.
    let reset = eval::run(
        &pool,
        EvalOptions {
            reset: true,
            clerk: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        reset.status,
        EvalStatus::Created | EvalStatus::Reset
    ));
    let store = reset.store_id;
    assert!(!v1.contains(&store), "the eval store has its own id");
    assert_eq!(reset.name, "Tạp hóa Cô Ba");
    let names: Vec<&str> = reset
        .members
        .iter()
        .map(|m| m.display_name.as_str())
        .collect();
    assert_eq!(names, ["Cô Ba", "Bé Na", "Anh Tư"]);
    let eval_ids = [store];

    // ---- fixtures ----
    let products = scalar(
        &pool,
        store,
        "SELECT count(*) FROM products WHERE store_id=$1",
    )
    .await;
    assert!((110..=130).contains(&products), "{products} products");
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM categories WHERE store_id=$1"
        )
        .await,
        10
    );
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(DISTINCT business_date) FROM sales WHERE store_id=$1"
        )
        .await,
        60
    );
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM sales WHERE store_id=$1 AND business_date NOT BETWEEN '2026-08-22' AND '2026-10-20'").await, 0);
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM members WHERE store_id=$1 AND display_name IN ('Cô Ba','Bé Na','Anh Tư')").await, 3);
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM members WHERE store_id=$1 AND role='lead'"
        )
        .await,
        1
    );
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM members WHERE store_id=$1 AND clerk_user_id <> ''"
        )
        .await,
        3
    );
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM invites WHERE store_id=$1 AND used_at IS NULL"
        )
        .await,
        1
    );
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM stores WHERE id=$1 AND bank_bin IS NOT NULL"
        )
        .await,
        1
    );
    // Nothing after 17:00 (Asia/Ho_Chi_Minh) on 2026-10-20 = 10:00 UTC.
    for (what, sql) in [
        (
            "sales",
            "SELECT count(*) FROM sales WHERE store_id=$1 AND (sold_at>'2026-10-20T10:00:00Z' OR voided_at>'2026-10-20T10:00:00Z' OR received_at>'2026-10-20T10:00:00Z')",
        ),
        (
            "expenses",
            "SELECT count(*) FROM expenses WHERE store_id=$1 AND (spent_at>'2026-10-20T10:00:00Z' OR created_at>'2026-10-20T10:00:00Z')",
        ),
        (
            "stock",
            "SELECT count(*) FROM stock_movements WHERE store_id=$1 AND created_at>'2026-10-20T10:00:00Z'",
        ),
        (
            "receipts",
            "SELECT count(*) FROM receipts WHERE store_id=$1 AND (created_at>'2026-10-20T10:00:00Z' OR confirmed_at>'2026-10-20T10:00:00Z' OR updated_at>'2026-10-20T10:00:00Z')",
        ),
        (
            "day closes",
            "SELECT count(*) FROM day_closes WHERE store_id=$1 AND (closed_at>'2026-10-20T10:00:00Z' OR business_date>='2026-10-20')",
        ),
        (
            "prices",
            "SELECT count(*) FROM price_history WHERE store_id=$1 AND changed_at>'2026-10-20T10:00:00Z'",
        ),
        (
            "outbox",
            "SELECT count(*) FROM outbox_events WHERE store_id=$1 AND created_at>'2026-10-20T10:00:00Z'",
        ),
    ] {
        assert_zero(&pool, store, what, sql).await;
    }
    let threshold =
        "coalesce(low_stock_threshold,(SELECT low_stock_threshold FROM stores WHERE id=$1))";
    let low: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM products WHERE store_id=$1 AND stock_quantity>0 AND stock_quantity<={threshold}")))
        .bind(store).fetch_one(&pool).await.unwrap();
    assert!(low >= 8, "{low} low-stock products");
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM products WHERE store_id=$1 AND stock_quantity<0"
        )
        .await,
        2
    );
    assert!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM products WHERE store_id=$1 AND stock_quantity IS NULL"
        )
        .await
            >= 8
    );
    let dead = scalar(&pool, store, "SELECT count(*) FROM products p WHERE p.store_id=$1 AND p.stock_quantity>0 AND NOT EXISTS (SELECT 1 FROM sale_lines l JOIN sales s ON s.id=l.sale_id WHERE l.product_id=p.id AND s.status='completed' AND s.business_date > DATE '2026-10-20' - 30)").await;
    assert!(dead >= 5, "{dead} dead-stock products");
    assert!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM products WHERE store_id=$1 AND cost_price>price"
        )
        .await
            >= 2
    );
    assert!(scalar(&pool, store, "SELECT count(*) FROM products WHERE store_id=$1 AND cost_price<=price AND (price-cost_price)*10<price").await >= 2, "thin margins");
    assert!(scalar(&pool, store, "SELECT count(*) FROM sale_lines WHERE store_id=$1 AND source='manual' AND review_status='open' AND product_id IS NULL").await >= 6, "unresolved manual lines");
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM receipts WHERE store_id=$1 AND status='draft'"
        )
        .await,
        1
    );
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM receipts WHERE store_id=$1 AND status='draft' AND ocr_text LIKE '%CANARY-OCR-4482%'").await, 1);
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM receipt_lines l JOIN receipts r ON r.id=l.receipt_id WHERE r.store_id=$1 AND r.status='draft' AND l.product_id IS NULL").await, 1);
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM receipt_lines l JOIN receipts r ON r.id=l.receipt_id WHERE r.store_id=$1 AND r.status='draft' AND l.product_id IS NOT NULL AND l.match_confidence<0.6").await, 1);
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM products WHERE store_id=$1 AND name LIKE '%CANARY-PRODUCT-7731%'"
        )
        .await,
        1
    );
    assert!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM receipts WHERE store_id=$1 AND status='confirmed'"
        )
        .await
            >= 18
    );
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM day_closes WHERE store_id=$1 AND difference<>0"
        )
        .await,
        1
    );
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM day_closes WHERE store_id=$1 AND difference=-120000 AND business_date='2026-10-14'").await, 1);
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM (SELECT member_id FROM sales WHERE store_id=$1 AND status='voided' GROUP BY member_id ORDER BY count(*) DESC LIMIT 1) top JOIN members m ON m.id=top.member_id WHERE m.display_name='Anh Tư'").await, 1);
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM price_history WHERE store_id=$1 AND field='price' AND old_value IS NOT NULL AND abs(new_value-old_value)*4>old_value").await, 1, "one sudden price change");
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM expenses WHERE store_id=$1 AND category='dien' AND business_date>='2026-10-19' AND paid_with='cash_box'").await, 2);
    assert!(scalar(&pool, store, "SELECT count(*) FROM product_images pi JOIN products p ON p.id=pi.product_id WHERE p.store_id=$1").await > 200);
    assert!(scalar(&pool, store, "SELECT count(*) FROM products p WHERE p.store_id=$1 AND (SELECT count(*) FROM product_images pi WHERE pi.product_id=p.id)<3").await >= 10);
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM products WHERE store_id=$1 AND category_id IS NULL"
        )
        .await,
        1
    );
    assert_eq!(scalar(&pool, store, "SELECT count(*) FROM product_embeddings WHERE store_id=$1").await, scalar(&pool, store, "SELECT count(*) FROM product_images pi JOIN products p ON p.id=pi.product_id WHERE p.store_id=$1").await);

    // ---- the money, stock and event invariants the v1 seed also holds ----
    assert_zero(&pool, store, "sale totals", "SELECT count(*) FROM sales s WHERE s.store_id=$1 AND (s.total<>(SELECT sum(l.line_total) FROM sale_lines l WHERE l.sale_id=s.id) OR s.business_date<>(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date OR (s.payment_method='cash' AND s.cash_received<s.total) OR (s.status='voided' AND (s.void_reason IS NULL OR s.voided_by IS NULL)) OR s.code !~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$')").await;
    assert_zero(&pool, store, "expenses", "SELECT count(*) FROM expenses e WHERE e.store_id=$1 AND (e.business_date<>(e.spent_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date OR (e.category='nhap_hang' AND e.amount<>(SELECT sum(p.quantity*p.unit_cost) FROM purchase_lines p WHERE p.expense_id=e.id)))").await;
    assert_zero(&pool, store, "day closes", "SELECT count(*) FROM day_closes d WHERE d.store_id=$1 AND (d.expected_cash<>d.opening_float+d.cash_sales-d.cash_refunds-d.cash_expenses OR d.difference<>d.counted_cash-d.expected_cash OR d.cash_sales<>(SELECT COALESCE(sum(total),0) FROM sales s WHERE s.store_id=d.store_id AND s.business_date=d.business_date AND payment_method='cash') OR d.cash_refunds<>(SELECT COALESCE(sum(total),0) FROM sales s WHERE s.store_id=d.store_id AND s.business_date=d.business_date AND payment_method='cash' AND status='voided') OR d.cash_expenses<>(SELECT COALESCE(sum(amount),0) FROM expenses e WHERE e.store_id=d.store_id AND e.business_date=d.business_date AND paid_with='cash_box' AND deleted_at IS NULL) OR d.transfer_revenue<>(SELECT COALESCE(sum(total),0) FROM sales s WHERE s.store_id=d.store_id AND s.business_date=d.business_date AND payment_method='transfer' AND status='completed'))").await;
    assert_zero(&pool, store, "sale lines", "SELECT count(*) FROM sale_lines WHERE store_id=$1 AND ((source='manual' AND product_id IS NOT NULL) OR (source='manual' AND review_status IS NULL) OR (price_mismatch AND review_status IS NULL))").await;
    assert_zero(&pool, store, "unit snapshot", "SELECT count(*) FROM sale_lines l LEFT JOIN product_units u ON u.id=l.unit_id WHERE l.store_id=$1 AND ((l.unit_id IS NOT NULL AND (l.quantity_in_base<>u.quantity_in_base OR l.product_id<>u.product_id)) OR (l.unit_id IS NULL AND l.quantity_in_base<>1))").await;
    assert_zero(&pool, store, "price mismatch flag", "SELECT count(*) FROM sale_lines l JOIN sales s ON s.id=l.sale_id LEFT JOIN product_units u ON u.id=l.unit_id WHERE l.store_id=$1 AND l.source<>'manual' AND l.price_mismatch IS DISTINCT FROM (l.unit_price<>CASE WHEN l.unit_id IS NOT NULL THEN u.price ELSE (SELECT h.new_value FROM price_history h WHERE h.product_id=l.product_id AND h.field='price' AND h.unit_id IS NULL AND h.changed_at<=s.sold_at ORDER BY h.changed_at DESC LIMIT 1) END)").await;
    assert_zero(&pool, store, "stock = ledger", "SELECT count(*) FROM products p WHERE p.store_id=$1 AND p.stock_quantity IS DISTINCT FROM (SELECT sum(delta)::int FROM stock_movements m WHERE m.product_id=p.id)").await;
    assert_zero(&pool, store, "ledger running sum", "SELECT count(*) FROM (SELECT quantity_after,sum(delta) OVER (PARTITION BY product_id ORDER BY created_at,id) expected FROM stock_movements WHERE store_id=$1) ledger WHERE quantity_after<>expected").await;
    assert_zero(&pool, store, "receipts", "SELECT count(*) FROM receipts r WHERE r.store_id=$1 AND r.status='confirmed' AND NOT (r.confirmed_at IS NOT NULL AND r.total=(SELECT sum(cost) FROM receipt_lines WHERE receipt_id=r.id) AND EXISTS(SELECT 1 FROM expenses e WHERE e.id=r.expense_id AND e.category='nhap_hang' AND e.amount=r.total) AND EXISTS(SELECT 1 FROM stock_movements WHERE ref_id=r.id AND reason='receipt'))").await;
    assert_zero(&pool, store, "receipt supplier", "SELECT count(*) FROM receipts r WHERE r.store_id=$1 AND (r.supplier IS NULL OR (r.status='confirmed' AND NOT EXISTS(SELECT 1 FROM expenses e WHERE e.id=r.expense_id AND e.note='Nhập hàng: '||r.supplier)) OR (r.status='draft' AND r.supplier<>'Đại lý Hưng Thịnh') OR lower(split_part(r.ocr_text,E'\n',1))<>lower(r.supplier))").await;
    assert_zero(&pool, store, "embeddings", "SELECT count(*) FROM product_embeddings WHERE store_id=$1 AND abs(vector_norm(embedding)-1)>0.000001").await;
    assert_zero(&pool, store, "outbox envelope", "SELECT count(*) FROM outbox_events WHERE store_id=$1 AND (payload->>'id' <> 'evt_'||lpad(id::text,15,'0') OR payload->>'type'<>type OR payload->>'store_id'<>store_id::text OR payload->>'version'<>'1' OR NOT(payload ?& ARRAY['id','type','version','store_id','occurred_at','actor','data']) OR published_at IS NULL)").await;
    assert_zero(&pool, store, "catalog_version", "SELECT count(*) FROM scans WHERE store_id=$1 AND catalog_version NOT BETWEEN (SELECT min(seq) FROM change_log WHERE store_id=$1) AND (SELECT max(seq) FROM change_log WHERE store_id=$1)").await;
    assert_eq!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM change_log WHERE store_id=$1 AND entity='product'"
        )
        .await,
        products
    );
    assert!(
        scalar(
            &pool,
            store,
            "SELECT count(*) FROM margin_alerts WHERE store_id=$1 AND status='open'"
        )
        .await
            >= 6
    );
    assert_zero(&pool, store, "one open alert per product", "SELECT count(*) FROM (SELECT product_id FROM margin_alerts WHERE store_id=$1 AND status='open' GROUP BY product_id HAVING count(*)>1) d").await;

    // ---- rerun is a no-op ----
    let counts_1 = all_counts(&pool, &eval_ids).await;
    let prints_1 = fingerprints(&pool, &eval_ids).await;
    let daily_1 = daily_checksum(&pool, store).await;
    let rerun = eval::run(&pool, EvalOptions::default()).await.unwrap();
    assert_eq!(rerun.status, EvalStatus::Existing);
    assert_eq!(rerun.store_id, store);
    assert_eq!(
        counts_1,
        all_counts(&pool, &eval_ids).await,
        "rerun changed row counts"
    );
    assert_eq!(
        prints_1,
        fingerprints(&pool, &eval_ids).await,
        "rerun changed rows"
    );
    // Concurrent reruns serialize on the advisory lock.
    let (a, b) = tokio::join!(
        eval::run(&pool, EvalOptions::default()),
        eval::run(&pool, EvalOptions::default())
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(counts_1, all_counts(&pool, &eval_ids).await);

    // ---- reset deletes every row of the store and reproduces the same content ----
    let again = eval::run(
        &pool,
        EvalOptions {
            reset: true,
            clerk: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(again.status, EvalStatus::Reset);
    assert_eq!(again.store_id, store);
    let counts_2 = all_counts(&pool, &eval_ids).await;
    assert_eq!(counts_1, counts_2, "reset changed row counts");
    assert_eq!(
        prints_1,
        fingerprints(&pool, &eval_ids).await,
        "reset changed content"
    );
    assert_eq!(
        daily_1,
        daily_checksum(&pool, store).await,
        "reset changed sales per day"
    );
    // No orphans of the previous generation survive anywhere.
    assert_zero(&pool, store, "orphan images", "SELECT count(*) FROM images i WHERE i.store_id=$1 AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.image_id=i.id) AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.image_id=i.id) AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.image_id=i.id)").await;

    // ---- the v1 stores never changed ----
    assert_eq!(
        v1_counts_before,
        all_counts(&pool, &v1).await,
        "v1 row counts changed"
    );
    assert_eq!(v1_before, fingerprints(&pool, &v1).await, "v1 rows changed");
    // And the v1 seed still treats a database holding the eval store as already seeded.
    let before_all: i64 = sqlx::query_scalar("SELECT count(*) FROM stores")
        .fetch_one(&pool)
        .await
        .unwrap();
    taphoa_api::seed::run(&pool).await.unwrap();
    let after_all: i64 = sqlx::query_scalar("SELECT count(*) FROM stores")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before_all, after_all);
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn reset_removes_the_eval_store_completely_before_reseeding() {
    let _one_at_a_time = DATABASE.lock().await;
    let Some(pool) = connect().await else { return };
    let report = eval::run(
        &pool,
        EvalOptions {
            reset: true,
            clerk: None,
        },
    )
    .await
    .unwrap();
    let store = report.store_id;
    // Anything the eval store owns, including images and outbox events, is gone after a delete
    // that precedes the reseed; prove it by tagging rows with a marker and resetting.
    sqlx::query("INSERT INTO outbox_events (store_id,type,payload,created_at) VALUES ($1,'eval.marker','{}','2026-10-01T00:00:00Z')")
        .bind(store)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose) VALUES ($1,$2,'images/eval-marker.jpg','image/jpeg',10,'other')")
        .bind(Uuid::from_u128(0xe7a1_0e7a_0000_4000_8000_00ff_ffff_ff01))
        .bind(store)
        .execute(&pool)
        .await
        .unwrap();
    eval::run(
        &pool,
        EvalOptions {
            reset: true,
            clerk: None,
        },
    )
    .await
    .unwrap();
    for sql in [
        "SELECT count(*) FROM outbox_events WHERE type='eval.marker'",
        "SELECT count(*) FROM images WHERE object_key='images/eval-marker.jpg'",
    ] {
        let n: i64 = sqlx::query_scalar(sql).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "{sql}");
    }
}

fn seed_bin() -> Command {
    // Archived (nextest) runs relocate binaries; the runtime variable is the one to trust.
    let bin = std::env::var("CARGO_BIN_EXE_taphoa-seed")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_taphoa-seed").to_string());
    let mut cmd = Command::new(bin);
    cmd.env_remove("RAILWAY_ENVIRONMENT_NAME")
        .env("DATABASE_URL", "postgres://unreachable.invalid/none");
    cmd
}

#[test]
fn binary_refuses_to_run_in_production() {
    for args in [
        vec!["--profile", "eval"],
        vec![],
        vec!["--profile", "eval", "--reset"],
    ] {
        let out = seed_bin()
            .args(&args)
            .env("RAILWAY_ENVIRONMENT_NAME", "production")
            .output()
            .unwrap();
        assert!(!out.status.success(), "{args:?} ran in production");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("production"), "{stderr}");
        assert!(!String::from_utf8_lossy(&out.stdout).contains("Recovery code"));
    }
}

#[test]
fn binary_rejects_unknown_flags_before_touching_the_database() {
    for args in [
        vec!["--profile", "nope"],
        vec!["--reset"],
        vec!["--profile"],
        vec!["--surprise"],
    ] {
        let out = seed_bin().args(&args).output().unwrap();
        assert!(!out.status.success(), "{args:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("usage") || stderr.contains("Usage"),
            "{args:?}: {stderr}"
        );
    }
}
