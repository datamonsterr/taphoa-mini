//! Scheduler uses real persistence and an in-process push adapter; no Expo/model calls.
mod common;

use async_trait::async_trait;
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use common::world::World;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use taphoa_api::{
    assistant::digest::{
        self,
        job::{self, DigestJobConfig},
    },
    push::{PushApi, PushMessage, Receipt, Ticket},
};
use uuid::Uuid;

// run_once intentionally visits every active store in this database.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct MockPush {
    messages: Mutex<Vec<PushMessage>>,
    fail_tokens: Mutex<HashSet<String>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    receipts: Mutex<HashMap<String, Receipt>>,
}
#[async_trait]
impl PushApi for MockPush {
    async fn send(&self, messages: &[PushMessage]) -> anyhow::Result<Vec<Ticket>> {
        self.messages.lock().unwrap().extend_from_slice(messages);
        anyhow::ensure!(
            !messages
                .iter()
                .any(|m| self.fail_tokens.lock().unwrap().contains(&m.to)),
            "scripted transport failure"
        );
        Ok(messages
            .iter()
            .map(|message| {
                self.tickets
                    .lock()
                    .unwrap()
                    .get(&message.to)
                    .cloned()
                    .unwrap_or_else(|| Ticket {
                        status: "ok".into(),
                        id: Some(Uuid::new_v4().to_string()),
                        message: None,
                        error: None,
                    })
            })
            .collect())
    }
    async fn receipts(&self, ids: &[String]) -> anyhow::Result<HashMap<String, Receipt>> {
        Ok(self
            .receipts
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| ids.contains(id))
            .map(|(id, receipt)| (id.clone(), receipt.clone()))
            .collect())
    }
    fn server_address(&self) -> &str {
        "mock-push"
    }
}

async fn fixture() -> (World, Arc<MockPush>) {
    let mut world = World::new().await;
    // No model adapter or Redis quota state is needed for the template fallback.
    world.state.assistant.model = None;
    world.state.redis = None;
    let mock = Arc::new(MockPush::default());
    world.state.push = Some(mock.clone());
    (world, mock)
}
async fn register(world: &World) -> String {
    let token = format!("ExponentPushToken[{}]", Uuid::new_v4());
    world
        .checked(
            "POST",
            "/v1/devices",
            "/v1/devices",
            &world.lead,
            json!({"token": token, "platform": "android", "app_version": "1.0", "language": "vi"}),
            StatusCode::OK,
        )
        .await;
    token
}
async fn age_members(world: &World) {
    sqlx::query("UPDATE members SET created_at=now()-interval '60 days' WHERE store_id=$1")
        .bind(world.store_id)
        .execute(world.pool())
        .await
        .unwrap();
}
async fn pushed_at(world: &World) -> Option<chrono::DateTime<Utc>> {
    sqlx::query_scalar(
        "SELECT pushed_at FROM assistant_digests WHERE store_id=$1 AND business_date=$2",
    )
    .bind(world.store_id)
    .bind(taphoa_api::time::business_date(Utc::now()))
    .fetch_one(world.pool())
    .await
    .unwrap()
}
async fn cleanup(world: &World) {
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(world.store_id)
        .execute(world.pool())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn registered_device_activates_store_and_pushes_only_once_per_day() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    age_members(&world).await;
    let token = register(&world).await;
    sqlx::query("UPDATE devices SET created_at=now()-interval '60 days',updated_at=now()-interval '60 days' WHERE token=$1")
        .bind(&token).execute(world.pool()).await.unwrap();
    assert!(
        !digest::active_store_ids(world.pool(), Duration::days(30))
            .await
            .unwrap()
            .contains(&world.store_id)
    );
    world
        .checked(
            "POST",
            "/v1/devices",
            "/v1/devices",
            &world.lead,
            json!({"token": token, "platform": "android", "app_version": "1.0", "language": "vi"}),
            StatusCode::OK,
        )
        .await;
    assert!(
        digest::active_store_ids(world.pool(), Duration::days(30))
            .await
            .unwrap()
            .contains(&world.store_id)
    );
    let now = Utc::now();
    let first = job::run_once(&world.state, now).await.unwrap();
    assert!(first.generated >= 1);
    assert!(first.pushed_stores >= 1);
    assert!(pushed_at(&world).await.is_some());
    let digest = digest::get_or_generate(
        &world.state,
        world.store_id,
        taphoa_api::time::business_date(now),
    )
    .await
    .unwrap();
    let generated_at = digest.generated_at;
    let second = job::run_once(&world.state, now).await.unwrap();
    assert_eq!(second.generated, 0);
    assert_eq!(second.pushed_stores, 0);
    let messages: Vec<Value> = {
        let messages = mock.messages.lock().unwrap();
        messages
            .iter()
            .filter(|m| m.to == token)
            .map(|m| serde_json::to_value(m).unwrap())
            .collect()
    };
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["to"], token);
    assert_eq!(messages[0]["channelId"], "digest");
    assert_eq!(messages[0]["data"]["url"], "/digest?entry=push");
    assert_eq!(
        messages[0]["data"]["business_date"],
        taphoa_api::time::business_date(now).to_string()
    );
    assert_eq!(
        digest::get_or_generate(
            &world.state,
            world.store_id,
            taphoa_api::time::business_date(now)
        )
        .await
        .unwrap()
        .generated_at,
        generated_at
    );
    cleanup(&world).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn active_store_without_devices_still_gets_generated_and_claimed() {
    let _serial = SERIAL.lock().await;
    let (world, _) = fixture().await;
    age_members(&world).await;
    let sale_id = Uuid::new_v4();
    sqlx::query("INSERT INTO sales(id,store_id,code,member_id,sold_at,business_date,payment_method,total,request_hash) VALUES($1,$2,$3,$4,now(),$5,'cash',0,'hash')")
        .bind(sale_id).bind(world.store_id).bind(sale_id.to_string()).bind(world.lead_id)
        .bind(taphoa_api::time::business_date(Utc::now())).execute(world.pool()).await.unwrap();
    job::run_once(&world.state, Utc::now()).await.unwrap();
    assert!(pushed_at(&world).await.is_some());
    cleanup(&world).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn unregistered_ticket_removes_device_and_counts_failure() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let token = register(&world).await;
    mock.tickets.lock().unwrap().insert(
        token.clone(),
        Ticket {
            status: "error".into(),
            id: None,
            message: None,
            error: Some("DeviceNotRegistered".into()),
        },
    );
    let report = job::run_once(&world.state, Utc::now()).await.unwrap();
    assert!(report.failed >= 1);
    assert!(report.unregistered >= 1);
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE token=$1)")
        .bind(token)
        .fetch_one(world.pool())
        .await
        .unwrap();
    assert!(!exists);
    cleanup(&world).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn receipts_after_delay_mark_ticket_ok() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let token = register(&world).await;
    let ticket_id = Uuid::new_v4().to_string();
    mock.tickets.lock().unwrap().insert(
        token,
        Ticket {
            status: "ok".into(),
            id: Some(ticket_id.clone()),
            message: None,
            error: None,
        },
    );
    mock.receipts.lock().unwrap().insert(
        ticket_id.clone(),
        Receipt {
            status: "ok".into(),
            message: None,
            error: None,
        },
    );
    job::run_once(&world.state, Utc::now()).await.unwrap();
    let created_at: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT created_at FROM push_tickets WHERE ticket_id=$1")
            .bind(&ticket_id)
            .fetch_one(world.pool())
            .await
            .unwrap();
    let delay = Duration::from_std(DigestJobConfig::default().receipt_delay).unwrap();
    job::receipts_once(&world.state, created_at + delay - Duration::seconds(1))
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM push_tickets WHERE ticket_id=$1")
        .bind(&ticket_id)
        .fetch_one(world.pool())
        .await
        .unwrap();
    assert_eq!(status, "pending_receipt");
    let report = job::receipts_once(&world.state, created_at + delay)
        .await
        .unwrap();
    assert!(report.ok >= 1);
    let status: String = sqlx::query_scalar("SELECT status FROM push_tickets WHERE ticket_id=$1")
        .bind(ticket_id)
        .fetch_one(world.pool())
        .await
        .unwrap();
    assert_eq!(status, "receipt_ok");
    cleanup(&world).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn missing_push_adapter_leaves_generated_digest_unclaimed() {
    let _serial = SERIAL.lock().await;
    let (mut world, mock) = fixture().await;
    register(&world).await;
    world.state.push = None;
    let report = job::run_once(&world.state, Utc::now()).await.unwrap();
    assert!(report.generated >= 1);
    assert_eq!(report.sent, 0);
    assert_eq!(report.pushed_stores, 0);
    assert!(pushed_at(&world).await.is_none());
    assert!(mock.messages.lock().unwrap().is_empty());
    assert_eq!(
        job::receipts_once(&world.state, Utc::now())
            .await
            .unwrap()
            .ok,
        0
    );
    cleanup(&world).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn concurrent_runs_claim_each_store_only_once() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let token = register(&world).await;
    let now = Utc::now();
    let (first, second) = tokio::join!(
        job::run_once(&world.state, now),
        job::run_once(&world.state, now)
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(
        mock.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to == token)
            .count(),
        1
    );
    assert!(pushed_at(&world).await.is_some());
    cleanup(&world).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn one_store_generation_or_delivery_failure_does_not_stop_other_stores() {
    let _serial = SERIAL.lock().await;
    let (broken_generation, mock) = fixture().await;
    let (mut broken_delivery, _) = fixture().await;
    let (mut healthy, _) = fixture().await;
    broken_delivery.state.push = Some(mock.clone());
    healthy.state.push = Some(mock.clone());
    register(&broken_generation).await;
    let failed_token = register(&broken_delivery).await;
    let healthy_token = register(&healthy).await;
    sqlx::query("UPDATE members SET active=false WHERE store_id=$1")
        .bind(broken_generation.store_id)
        .execute(broken_generation.pool())
        .await
        .unwrap();
    mock.fail_tokens.lock().unwrap().insert(failed_token);
    let report = job::run_once(&healthy.state, Utc::now()).await.unwrap();
    assert!(report.failed >= 1);
    assert!(pushed_at(&healthy).await.is_some());
    assert_eq!(
        mock.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to == healthy_token)
            .count(),
        1
    );
    cleanup(&broken_generation).await;
    cleanup(&broken_delivery).await;
    cleanup(&healthy).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn startup_catches_up_and_restart_does_not_repeat_push() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let token = register(&world).await;
    let config = DigestJobConfig {
        send_at: chrono::NaiveTime::MIN,
        ..DigestJobConfig::default()
    };
    let wait_for = |token: String| {
        let mock = mock.clone();
        async move {
            tokio::time::timeout(std::time::Duration::from_secs(20), async {
                loop {
                    if mock.messages.lock().unwrap().iter().any(|m| m.to == token) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("startup catch-up must send");
        }
    };
    let (stop, receive) = tokio::sync::watch::channel(false);
    let task = job::spawn(world.state.clone(), config.clone(), receive);
    wait_for(token.clone()).await;
    stop.send(true).unwrap();
    task.await.unwrap();
    // A new active store proves that the restarted scheduler completes its catch-up.
    let (probe, _) = fixture().await;
    let probe_token = register(&probe).await;
    let (stop, receive) = tokio::sync::watch::channel(false);
    let task = job::spawn(world.state.clone(), config, receive);
    wait_for(probe_token).await;
    stop.send(true).unwrap();
    task.await.unwrap();
    assert_eq!(
        mock.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to == token)
            .count(),
        1
    );
    cleanup(&world).await;
    cleanup(&probe).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn scheduler_honors_custom_active_window_and_receipt_delay() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let (old, _) = fixture().await;
    age_members(&old).await;
    let old_token = register(&old).await;
    sqlx::query("UPDATE devices SET created_at=now()-interval '2 days',updated_at=now()-interval '2 days' WHERE token=$1")
        .bind(old_token)
        .execute(old.pool())
        .await
        .unwrap();
    let token = register(&world).await;
    let ticket_id = Uuid::new_v4().to_string();
    mock.tickets.lock().unwrap().insert(
        token,
        Ticket {
            status: "ok".into(),
            id: Some(ticket_id.clone()),
            message: None,
            error: None,
        },
    );
    mock.receipts.lock().unwrap().insert(
        ticket_id.clone(),
        Receipt {
            status: "ok".into(),
            message: None,
            error: None,
        },
    );
    let config = DigestJobConfig {
        send_at: chrono::NaiveTime::MIN,
        active_window: Duration::days(1),
        receipt_delay: std::time::Duration::from_millis(20),
        ..DigestJobConfig::default()
    };
    let (stop, receive) = tokio::sync::watch::channel(false);
    let task = job::spawn(world.state.clone(), config, receive);
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let status: Option<String> =
                sqlx::query_scalar("SELECT status FROM push_tickets WHERE ticket_id=$1")
                    .bind(&ticket_id)
                    .fetch_optional(world.pool())
                    .await
                    .unwrap();
            if status.as_deref() == Some("receipt_ok") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("scheduler must check receipts using its configured delay");
    stop.send(true).unwrap();
    task.await.unwrap();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assistant_digests WHERE store_id=$1)")
            .bind(old.store_id)
            .fetch_one(old.pool())
            .await
            .unwrap();
    assert!(
        !exists,
        "device outside configured active window must be skipped"
    );
    cleanup(&world).await;
    cleanup(&old).await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn failed_send_without_tickets_releases_claim_and_retries() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let token = register(&world).await;
    mock.fail_tokens.lock().unwrap().insert(token.clone());
    let now = Utc::now();
    let report = job::run_once(&world.state, now).await.unwrap();
    assert!(report.failed >= 1);
    assert!(
        pushed_at(&world).await.is_none(),
        "failed send must release claim"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM push_tickets WHERE store_id=$1")
        .bind(world.store_id)
        .fetch_one(world.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    mock.fail_tokens.lock().unwrap().remove(&token);
    job::run_once(&world.state, now).await.unwrap();
    assert!(pushed_at(&world).await.is_some());
    assert_eq!(
        mock.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to == token)
            .count(),
        2
    );
    cleanup(&world).await;
}

#[tokio::test]
async fn active_store_lookup_failure_fails_the_run() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@localhost:1/unused")
        .unwrap();
    pool.close().await;
    let state = taphoa_api::AppState {
        postgres: Some(pool),
        ..Default::default()
    };
    assert!(job::run_once(&state, Utc::now()).await.is_err());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn failed_later_batch_keeps_claim_when_tickets_were_already_recorded() {
    let _serial = SERIAL.lock().await;
    let (world, mock) = fixture().await;
    let tokens: Vec<_> = (0..101)
        .map(|i| format!("ExpoPushToken[{}-{i:03}]", world.store_id))
        .collect();
    sqlx::query("INSERT INTO devices(token,store_id,member_id,platform,app_version,language) SELECT unnest($1::text[]),$2,$3,'android','1','vi'")
        .bind(&tokens).bind(world.store_id).bind(world.lead_id).execute(world.pool()).await.unwrap();
    mock.fail_tokens.lock().unwrap().insert(tokens[100].clone());
    let now = Utc::now();
    let report = job::run_once(&world.state, now).await.unwrap();
    assert!(report.failed >= 1);
    assert!(pushed_at(&world).await.is_some());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM push_tickets WHERE store_id=$1")
        .bind(world.store_id)
        .fetch_one(world.pool())
        .await
        .unwrap();
    assert_eq!(count, 100);
    mock.fail_tokens.lock().unwrap().clear();
    job::run_once(&world.state, now).await.unwrap();
    assert_eq!(
        mock.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| tokens.contains(&m.to))
            .count(),
        101
    );
    cleanup(&world).await;
}
