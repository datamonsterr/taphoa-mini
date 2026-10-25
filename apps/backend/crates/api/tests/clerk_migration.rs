//! Apply 0701 inside isolated schemas so this never resets a shared database.
use sqlx::{Connection, PgConnection};
#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn clerk_reset_applies_on_empty_and_populated_schema() {
    let url = std::env::var("DATABASE_URL").unwrap();
    for populated in [false, true] {
        let mut conn = PgConnection::connect(&url).await.unwrap();
        sqlx::raw_sql("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public").execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let schema = format!("clerk_migration_{}", uuid::Uuid::new_v4().simple());
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema}, public"
        )))
        .execute(&mut *tx)
        .await
        .unwrap();
        for migration in taphoa_api::MIGRATOR.iter().filter(|m| m.version < 701) {
            sqlx::raw_sql(migration.sql.clone())
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        if populated {
            sqlx::raw_sql("INSERT INTO stores(id,name,recovery_code_hash) VALUES ('00000000-0000-0000-0000-000000000001','old','hash'); INSERT INTO members(id,store_id,display_name,role) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','old','lead'); INSERT INTO sessions(store_id,member_id,device_name,platform,refresh_token_hash,expires_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','old','web','\\x01',now()); INSERT INTO images(id,object_key,content_type,byte_size) VALUES (gen_random_uuid(),'orphan','image/jpeg',1); INSERT INTO outbox_events(store_id,type,payload) VALUES ('00000000-0000-0000-0000-000000000001','old','{}')").execute(&mut *tx).await.unwrap();
        }
        let migration = taphoa_api::MIGRATOR
            .iter()
            .find(|m| m.version == 701)
            .expect("0701 exists");
        sqlx::raw_sql(migration.sql.clone())
            .execute(&mut *tx)
            .await
            .unwrap();
        let tables: Vec<String> =
            sqlx::query_scalar("SELECT tablename FROM pg_tables WHERE schemaname=$1")
                .bind(&schema)
                .fetch_all(&mut *tx)
                .await
                .unwrap();
        assert!(!tables.iter().any(|t| t == "sessions"));
        for table in tables {
            let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM {schema}.{table}"
            )))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        sqlx::raw_sql("INSERT INTO stores(id,name) VALUES ('00000000-0000-0000-0000-000000000001','new'); INSERT INTO members(store_id,display_name,role,clerk_user_id) VALUES ('00000000-0000-0000-0000-000000000001','new','lead','user_new')").execute(&mut *tx).await.unwrap();
        let columns:Vec<String>=sqlx::query_scalar("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('sales','stores','members')").bind(&schema).fetch_all(&mut *tx).await.unwrap();
        assert!(columns.iter().any(|c| c == "clerk_session_id"));
        assert!(!columns.iter().any(|c| {
            ["session_id", "recovery_code_hash", "recovery_code_lookup"].contains(&c.as_str())
        }));
        tx.rollback().await.unwrap();
    }
}
