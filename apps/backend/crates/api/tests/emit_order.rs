//! Per-store ordering: change_log.seq and outbox_events.id allocation order must equal commit order.
use serde_json::json;
use sqlx::PgPool;
use std::time::Duration;
use taphoa_api::events::{Event, emit};
use tokio::time::timeout;
use uuid::Uuid;

fn event(store_id: Uuid, name: &str) -> Event {
    Event {
        store_id,
        actor: Some((Uuid::new_v4(), Uuid::new_v4())),
        typ: "store.changed",
        version: 1,
        data: json!({"fields":[name]}),
        change: Some(("store", store_id, "upsert")),
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL"]
async fn concurrent_writers_in_one_store_cannot_commit_out_of_order() {
    let pool = PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let store = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id,name,recovery_code_hash) VALUES ($1,'order','x')")
        .bind(store)
        .execute(&pool)
        .await
        .unwrap();

    let mut first = pool.begin().await.unwrap();
    let a = emit(&mut first, event(store, "first")).await.unwrap();

    // The second writer must wait for the first to finish before it can allocate ids.
    let second_pool = pool.clone();
    let second = tokio::spawn(async move {
        let mut tx = second_pool.begin().await.unwrap();
        let b = emit(&mut tx, event(store, "second")).await.unwrap();
        tx.commit().await.unwrap();
        b
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !second.is_finished(),
        "second writer must block until the first commits"
    );

    first.commit().await.unwrap();
    let b = timeout(Duration::from_secs(5), second)
        .await
        .expect("second writer proceeds after the first commit")
        .unwrap();
    assert!(a.seq.unwrap() < b.seq.unwrap());
    assert!(a.id < b.id);

    // A reader that saw the later cursor has necessarily seen the earlier row.
    let visible: Vec<i64> =
        sqlx::query_scalar("SELECT seq FROM change_log WHERE store_id=$1 ORDER BY seq")
            .bind(store)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(visible, vec![a.seq.unwrap(), b.seq.unwrap()]);

    // Writers in different stores never wait for each other.
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO stores (id,name,recovery_code_hash) VALUES ($1,'order2','x')")
        .bind(other)
        .execute(&pool)
        .await
        .unwrap();
    let mut held = pool.begin().await.unwrap();
    emit(&mut held, event(store, "held")).await.unwrap();
    let mut free = pool.begin().await.unwrap();
    timeout(
        Duration::from_secs(2),
        emit(&mut free, event(other, "free")),
    )
    .await
    .expect("different store is not blocked")
    .unwrap();
    free.commit().await.unwrap();
    held.commit().await.unwrap();

    for id in [store, other] {
        sqlx::query("DELETE FROM stores WHERE id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
}
