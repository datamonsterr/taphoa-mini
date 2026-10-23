//! Real-database checks of seed money, authentication, event and replay contracts.
use argon2::{Argon2, password_hash::PasswordVerifier};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};

#[tokio::test]
#[ignore = "real Postgres required; DATABASE_URL must name a disposable seed database"]
async fn seeded_money_credentials_and_events_reconcile() -> anyhow::Result<()> {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    taphoa_api::MIGRATOR.run(&pool).await?;
    let report = taphoa_api::seed::run(&pool).await?;
    assert_eq!(report.stores.len(), 2);
    for store in &report.stores {
        let row =
            sqlx::query("SELECT recovery_code_hash,recovery_code_lookup FROM stores WHERE id=$1")
                .bind(store.store_id)
                .fetch_one(&pool)
                .await?;
        let normalized = store.recovery_code.replace('-', "");
        let hash: String = row.try_get("recovery_code_hash")?;
        assert!(hash.starts_with("$argon2id$"));
        assert!(
            Argon2::default()
                .verify_password(normalized.as_bytes(), hash.as_str())
                .is_ok()
        );
        let lookup: Vec<u8> = row.try_get("recovery_code_lookup")?;
        assert_eq!(lookup, Sha256::digest(normalized.as_bytes()).as_slice());
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM invites WHERE store_id=$1 AND token_hash=$2 AND used_at IS NULL AND expires_at>now())")
            .bind(store.store_id).bind(Sha256::digest(store.invite_token_hint.as_bytes()).to_vec())
            .fetch_one(&pool).await?;
        assert!(
            valid,
            "printed token must be ready to join on a fresh fixture"
        );
        for member in &store.members {
            if let Some(pin) = &member.pin {
                let hash: String = sqlx::query_scalar("SELECT pin_hash FROM members WHERE id=$1")
                    .bind(member.member_id)
                    .fetch_one(&pool)
                    .await?;
                assert!(
                    Argon2::default()
                        .verify_password(pin.as_bytes(), hash.as_str())
                        .is_ok()
                );
            }
        }
    }
    assert_no_rows(&pool, "SELECT count(*) FROM sales s WHERE s.total<>(SELECT sum(l.line_total) FROM sale_lines l WHERE l.sale_id=s.id) OR s.business_date<>(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date OR (s.payment_method='cash' AND s.cash_received<s.total) OR (s.status='voided' AND (s.void_reason IS NULL OR s.voided_by IS NULL)) OR s.code !~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$'").await?;
    assert_no_rows(&pool, "SELECT count(*) FROM expenses e WHERE e.business_date<>(e.spent_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date OR (e.category='nhap_hang' AND e.amount<>(SELECT sum(p.quantity*p.unit_cost) FROM purchase_lines p WHERE p.expense_id=e.id))").await?;
    assert_no_rows(&pool, "SELECT count(*) FROM day_closes d WHERE d.expected_cash<>d.opening_float+d.cash_sales-d.cash_refunds-d.cash_expenses OR d.difference<>d.counted_cash-d.expected_cash OR d.cash_sales<>(SELECT COALESCE(sum(total),0) FROM sales s WHERE s.store_id=d.store_id AND s.business_date=d.business_date AND payment_method='cash') OR d.cash_refunds<>(SELECT COALESCE(sum(total),0) FROM sales s WHERE s.store_id=d.store_id AND s.business_date=d.business_date AND payment_method='cash' AND status='voided') OR d.cash_expenses<>(SELECT COALESCE(sum(amount),0) FROM expenses e WHERE e.store_id=d.store_id AND e.business_date=d.business_date AND paid_with='cash_box' AND deleted_at IS NULL) OR d.transfer_revenue<>(SELECT COALESCE(sum(total),0) FROM sales s WHERE s.store_id=d.store_id AND s.business_date=d.business_date AND payment_method='transfer' AND status='completed')").await?;
    assert_no_rows(&pool, "SELECT count(*) FROM (SELECT store_id,business_date,count(*) n FROM sales GROUP BY store_id,business_date) days WHERE n NOT BETWEEN 15 AND 40").await?;
    let days: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT store_id,business_date FROM sales GROUP BY store_id,business_date) d").fetch_one(&pool).await?;
    assert_eq!(days, 60);
    assert_no_rows(&pool, "SELECT count(*) FROM sale_lines WHERE (source='manual' AND (product_id IS NOT NULL OR review_status IS DISTINCT FROM 'open' OR review_reason IS DISTINCT FROM 'manual_price')) OR (price_mismatch AND (review_status IS DISTINCT FROM 'open' OR review_reason IS DISTINCT FROM 'price_mismatch'))").await?;
    assert_no_rows(&pool, "SELECT count(*) FROM sale_lines l LEFT JOIN product_units u ON u.id=l.unit_id WHERE (l.unit_id IS NOT NULL AND (l.quantity_in_base<>u.quantity_in_base OR l.product_id<>u.product_id)) OR (l.unit_id IS NULL AND l.quantity_in_base<>1)").await?;
    assert_no_rows(&pool, "SELECT count(*) FROM sale_lines l JOIN sales s ON s.id=l.sale_id LEFT JOIN product_units u ON u.id=l.unit_id WHERE l.source<>'manual' AND l.price_mismatch IS DISTINCT FROM (l.unit_price<>CASE WHEN l.unit_id IS NOT NULL THEN u.price ELSE (SELECT h.new_value FROM price_history h WHERE h.product_id=l.product_id AND h.field='price' AND h.changed_at<=s.sold_at ORDER BY h.changed_at DESC LIMIT 1) END)").await?;
    assert_no_rows(
        &pool,
        "SELECT count(*) FROM product_embeddings WHERE abs(vector_norm(embedding)-1)>0.000001",
    )
    .await?;
    assert_no_rows(&pool, "SELECT count(*) FROM outbox_events WHERE payload->>'id' <> 'evt_'||lpad(id::text,15,'0') OR payload->>'type'<>type OR payload->>'store_id'<>store_id::text OR payload->>'version'<>'1' OR NOT(payload ?& ARRAY['id','type','version','store_id','occurred_at','actor','data']) OR (payload->'actor'->>'member_id') IS NULL").await?;
    let before = fingerprints(&pool).await?;
    let (left, right) = tokio::join!(taphoa_api::seed::run(&pool), taphoa_api::seed::run(&pool));
    left?;
    right?;
    assert_eq!(
        before,
        fingerprints(&pool).await?,
        "concurrent replay changed stored data"
    );
    Ok(())
}

async fn assert_no_rows(pool: &PgPool, query: &'static str) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar(query).fetch_one(pool).await?;
    assert_eq!(count, 0, "seed invariant failed: {query}");
    Ok(())
}

async fn fingerprints(pool: &PgPool) -> anyhow::Result<Vec<String>> {
    let mut fingerprints = Vec::new();
    // Audited identifiers only; values include every persisted column and timestamp.
    for table in [
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
    ] {
        let value: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT md5(string_agg(row_hash,',' ORDER BY row_hash)) FROM (SELECT md5(to_jsonb(t)::text) row_hash FROM {table} t) rows"
        ))).fetch_one(pool).await?;
        fingerprints.push(value);
    }
    Ok(fingerprints)
}
