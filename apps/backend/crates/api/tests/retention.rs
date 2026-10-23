//! Retention (data-model §3.8/§3.9): change_log compaction and published outbox cleanup.
//!
//! Pins `taphoa_api::retention::run_once(&PgPool) -> anyhow::Result<RetentionReport>`.
use sqlx::PgPool;
use taphoa_api::retention::run_once;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn compacts_old_change_log_rows_and_records_a_floor() {
    let pool = PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let store = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id,name,recovery_code_hash) VALUES ($1,'ret','x')")
        .bind(store)
        .execute(&pool)
        .await
        .unwrap();
    let (old_entity, fresh_entity, only_entity) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    // old_entity: two old versions + the newest (also old). fresh_entity: old + fresh version.
    // only_entity: a single old version, which is the newest one and must be kept.
    let insert = |entity: Uuid, age: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "INSERT INTO change_log (store_id,entity,entity_id,op,created_at) VALUES ($1,'category',$2,'upsert', now() - interval '{age}') RETURNING seq"
            )))
            .bind(store)
            .bind(entity)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let o1 = insert(old_entity, "60 days").await;
    let o2 = insert(old_entity, "50 days").await;
    let o3 = insert(old_entity, "40 days").await;
    let f1 = insert(fresh_entity, "45 days").await;
    let f2 = insert(fresh_entity, "1 day").await;
    let s1 = insert(only_entity, "90 days").await;

    let report = run_once(&pool).await.unwrap();
    assert!(report.change_log_deleted >= 3);
    let left: Vec<i64> =
        sqlx::query_scalar("SELECT seq FROM change_log WHERE store_id=$1 ORDER BY seq")
            .bind(store)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        left,
        vec![o3, f2, s1],
        "newest per entity kept; superseded rows older than 30 days gone"
    );
    let floor: i64 = sqlx::query_scalar("SELECT floor_seq FROM change_log_floor WHERE store_id=$1")
        .bind(store)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        floor,
        o2.max(f1),
        "floor = highest compacted seq, so older cursors get 410"
    );
    assert!(o1 < o2);

    // Idempotent: a second run changes nothing and never lowers the floor.
    run_once(&pool).await.unwrap();
    let again: i64 = sqlx::query_scalar("SELECT floor_seq FROM change_log_floor WHERE store_id=$1")
        .bind(store)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(again, floor);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn deletes_outbox_rows_seven_days_after_publish_only() {
    let pool = PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let store = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id,name,recovery_code_hash) VALUES ($1,'ret2','x')")
        .bind(store)
        .execute(&pool)
        .await
        .unwrap();
    let insert = |published: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "INSERT INTO outbox_events (store_id,type,payload,created_at,published_at) VALUES ($1,'store.changed','{{}}', now() - interval '30 days', {published}) RETURNING id"
            )))
            .bind(store)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let old = insert("now() - interval '8 days'").await;
    let recent = insert("now() - interval '1 day'").await;
    let unpublished = insert("NULL").await;
    let report = run_once(&pool).await.unwrap();
    assert!(report.outbox_deleted >= 1);
    let left: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM outbox_events WHERE store_id=$1 ORDER BY id")
            .bind(store)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(left, vec![recent, unpublished]);
    assert!(old < recent);
}
