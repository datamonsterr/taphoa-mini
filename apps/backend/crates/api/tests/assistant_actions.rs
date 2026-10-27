//! X3-T6 lifecycle against the real router and database.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::{
    Contract,
    world::{Reply, World},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use taphoa_api::{
    analytics::{Analytics, CaptureEvent},
    assistant::{
        Language,
        tools::{Registry, ToolContext, ToolError},
    },
    auth::{Actor, Role},
    storage::{ObjectStore, SignedUrl},
};
use tower::ServiceExt;
use uuid::Uuid;
const CONFIRM: &str = "/v1/assistant/actions/{actionId}/confirm";
const REJECT: &str = "/v1/assistant/actions/{actionId}/reject";
#[derive(Default)]
struct Recording(Mutex<Vec<CaptureEvent>>);
#[async_trait::async_trait]
impl Analytics for Recording {
    async fn capture_event(&self, event: CaptureEvent) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}
struct Storage;
#[async_trait::async_trait]
impl ObjectStore for Storage {
    async fn put(&self, _: &str, _: &str, _: Vec<u8>) -> anyhow::Result<()> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(&self, _: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        Ok(SignedUrl {
            url: "https://example.test/receipt.jpg".into(),
            expires_at: chrono::Utc::now() + ttl,
        })
    }
}
async fn world() -> (World, Arc<Recording>) {
    let mut w = World::new().await;
    let recording = Arc::new(Recording::default());
    w.state.analytics = recording.clone();
    w.state.storage = Some(Arc::new(Storage));
    w.app = taphoa_api::router(w.state.clone());
    (w, recording)
}
async fn context(w: &World, seller: bool) -> ToolContext {
    let member = if seller { w.seller_id } else { w.lead_id };
    let thread = sqlx::query_scalar(
        "INSERT INTO assistant_threads(store_id,member_id) VALUES($1,$2) RETURNING id",
    )
    .bind(w.store_id)
    .bind(member)
    .fetch_one(w.pool())
    .await
    .unwrap();
    let message=sqlx::query_scalar("INSERT INTO assistant_messages(thread_id,store_id,role,content) VALUES($1,$2,'assistant','Đề xuất') RETURNING id").bind(thread).bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    ToolContext {
        state: w.state.clone(),
        actor: Actor {
            member_id: member,
            store_id: w.store_id,
            clerk_user_id: "user_test".into(),
            clerk_session_id: "sess_test".into(),
            role: if seller { Role::Seller } else { Role::Lead },
            can_enroll: !seller,
        },
        today: chrono::NaiveDate::from_ymd_opt(2026, 10, 25).unwrap(),
        language: Language::Vi,
        thread_id: thread,
        message_id: message,
        trace_id: Some("0123456789abcdef0123456789abcdef".into()),
    }
}
async fn propose(ctx: &ToolContext, name: &str, args: Value) -> Value {
    let output = Registry::standard().run(ctx, name, args).await.unwrap();
    let a = output.action.unwrap();
    assert!(Contract::load().schema_accepts("AssistantAction", &a));
    assert_eq!(a["status"], "proposed");
    assert_eq!(output.data["action_id"], a["id"]);
    assert_eq!(output.data["note"], "Chờ chủ cửa hàng bấm Xác nhận");
    assert_eq!(a["message_id"], ctx.message_id.to_string());
    a
}
fn id(a: &Value) -> Uuid {
    a["id"].as_str().unwrap().parse().unwrap()
}
async fn decide(w: &World, a: &Value, token: &str, decision: &str, key: Option<&str>) -> Reply {
    decide_in(w, w.store_id, a, token, decision, key).await
}
async fn decide_in(
    w: &World,
    store_id: Uuid,
    a: &Value,
    token: &str,
    decision: &str,
    key: Option<&str>,
) -> Reply {
    let mut req = Request::builder()
        .method("POST")
        .uri(format!("/v1/assistant/actions/{}/{decision}", id(a)))
        .header("authorization", format!("Bearer {token}"))
        .header("x-store-id", store_id.to_string())
        .header("x-forwarded-for", "10.97.1.1");
    if let Some(key) = key {
        req = req.header("idempotency-key", key);
    }
    let res = w
        .app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let raw = to_bytes(res.into_body(), 8 << 20).await.unwrap().to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Contract::load().assert_conforms(
        if decision == "confirm" {
            CONFIRM
        } else {
            REJECT
        },
        "post",
        status,
        &body,
    );
    Reply {
        status,
        body,
        headers,
        raw,
    }
}
async fn confirm(w: &World, a: &Value) -> Value {
    let r = decide(w, a, &w.lead, "confirm", Some("confirm-1")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["status"], "done", "{}", r.body);
    r.body
}
async fn count(w: &World, table: &str) -> i64 {
    sqlx::query_scalar(match table {
        "stock_movements" => "SELECT count(*) FROM stock_movements WHERE store_id=$1",
        "expenses" => "SELECT count(*) FROM expenses WHERE store_id=$1",
        "invites" => "SELECT count(*) FROM invites WHERE store_id=$1",
        "purchase_lines" => "SELECT count(*) FROM purchase_lines WHERE store_id=$1",
        "assistant_actions" => "SELECT count(*) FROM assistant_actions WHERE store_id=$1",
        _ => panic!("unsupported test table"),
    })
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap()
}
async fn values(w: &World, p: Uuid) -> (i64, Option<i32>, Option<i32>) {
    sqlx::query_as("SELECT price,low_stock_threshold,stock_quantity FROM products WHERE id=$1")
        .bind(p)
        .fetch_one(w.pool())
        .await
        .unwrap()
}
async fn receipt(w: &World, p: Option<Uuid>) -> (Uuid, Uuid) {
    let image = Uuid::now_v7();
    sqlx::query("INSERT INTO images(id,store_id,object_key,content_type,byte_size,purpose) VALUES($1,$2,$3,'image/jpeg',10,'checkout')").bind(image).bind(w.store_id).bind(format!("images/test/{image}.jpg")).execute(w.pool()).await.unwrap();
    let r = Uuid::now_v7();
    sqlx::query("INSERT INTO receipts(id,store_id,member_id,image_id,ocr_text,parser,request_hash,total) VALUES($1,$2,$3,$4,'OCR','fallback','\\x00',20000)").bind(r).bind(w.store_id).bind(w.lead_id).bind(image).execute(w.pool()).await.unwrap();
    let l=sqlx::query_scalar("INSERT INTO receipt_lines(receipt_id,store_id,position,raw_text,product_name,quantity,cost,product_id) VALUES($1,$2,0,'OCR','Sữa',2,20000,$3) RETURNING id").bind(r).bind(w.store_id).bind(p).fetch_one(w.pool()).await.unwrap();
    (r, l)
}
async fn assert_events(w: &World) {
    let doc: Value = serde_norway::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../docs/api/asyncapi.yaml"
        ))
        .unwrap(),
    )
    .unwrap();
    let rows:Vec<(String,Value)>=sqlx::query_as("SELECT type,payload FROM outbox_events WHERE store_id=$1 AND type LIKE 'assistant.action.%'").bind(w.store_id).fetch_all(w.pool()).await.unwrap();
    assert!(!rows.is_empty());
    for (typ, payload) in rows {
        let msg = doc["components"]["messages"]
            .as_object()
            .unwrap()
            .values()
            .find(|m| m["name"] == typ)
            .unwrap();
        let schema = json!({"components":doc["components"],"allOf":[msg["payload"]]});
        let validator = jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&schema)
            .unwrap();
        assert!(validator.is_valid(&payload), "{payload}");
        assert!(!payload.to_string().contains("taphoa://join"));
    }
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn every_kind_proposes_without_business_writes_and_confirms_once() {
    let (w, recording) = world().await;
    let ctx = context(&w, false).await;
    let p = w.product("Sữa", 15000, Some(10000)).await;
    let (r, l) = receipt(&w, Some(p)).await;
    for (name, args) in [
        (
            "propose_stock_adjustment",
            json!({"product_id":p,"delta":3,"reason":"Kiểm kê"}),
        ),
        (
            "propose_expense",
            json!({"amount":150000,"category":"dien","note":"Tiền điện","paid_with":"cash_box"}),
        ),
        (
            "propose_price_change",
            json!({"product_id":p,"new_price":17000}),
        ),
        (
            "propose_threshold_update",
            json!({"product_id":p,"threshold":9}),
        ),
        (
            "propose_reorder_list",
            json!({"items":[{"product_id":p,"quantity":5}],"supplier":"Kho"}),
        ),
        (
            "propose_receipt_line_update",
            json!({"receipt_id":r,"line_id":l,"quantity":4,"cost":40000}),
        ),
        ("propose_invite", json!({"role":"seller","can_enroll":true})),
    ] {
        let tables = ["stock_movements", "expenses", "invites", "purchase_lines"];
        let mut before = Vec::new();
        for table in tables {
            before.push(count(&w, table).await);
        }
        let old = values(&w, p).await;
        let a = propose(&ctx, name, args).await;
        for (i, table) in tables.iter().enumerate() {
            assert_eq!(count(&w, table).await, before[i], "{name} wrote {table}");
        }
        assert_eq!(values(&w, p).await, old);
        let done = confirm(&w, &a).await;
        match name {
            "propose_stock_adjustment" => {
                assert_eq!(values(&w, p).await.2, Some(3));
                assert!(done["result"]["movement_id"].is_string());
            }
            "propose_expense" => {
                assert_eq!(count(&w, "expenses").await, 1);
                assert!(done["result"]["expense_id"].is_string());
            }
            "propose_price_change" => assert_eq!(values(&w, p).await.0, 17000),
            "propose_threshold_update" => assert_eq!(values(&w, p).await.1, Some(9)),
            "propose_reorder_list" => {
                assert_eq!(done["result"]["items"][0]["name"], "Sữa");
                assert_eq!(done["result"]["total_cost"], 50000);
            }
            "propose_receipt_line_update" => {
                let row: (i32, i64) =
                    sqlx::query_as("SELECT quantity,cost FROM receipt_lines WHERE id=$1")
                        .bind(l)
                        .fetch_one(w.pool())
                        .await
                        .unwrap();
                assert_eq!(row, (4, 40000));
            }
            "propose_invite" => {
                assert_eq!(count(&w, "invites").await, before[2] + 1);
                let url = done["result"]["join_url"].as_str().unwrap().to_owned();
                assert!(done["result"].get("token").is_none());
                // The secret is never stored: thread detail and the DB row only hold expires_at.
                let detail = w
                    .call(
                        "GET",
                        &format!("/v1/assistant/threads/{}", a["thread_id"].as_str().unwrap()),
                        &w.lead,
                        Value::Null,
                    )
                    .await;
                assert!(!detail.body.to_string().contains(&url));
                assert!(!detail.body.to_string().contains("join_url"));
                let stored: Value =
                    sqlx::query_scalar("SELECT result FROM assistant_actions WHERE id=$1")
                        .bind(id(&a))
                        .fetch_one(w.pool())
                        .await
                        .unwrap();
                assert_eq!(stored, json!({"expires_at":done["result"]["expires_at"]}));
                let replay = decide(&w, &a, &w.lead, "confirm", Some("confirm-1")).await;
                assert_eq!(replay.body["result"]["join_url"], Value::Null);
                assert!(replay.body["result"]["note"].is_string());
                assert!(!replay.raw.windows(url.len()).any(|x| x == url.as_bytes()));
            }
            _ => unreachable!(),
        }
        if name != "propose_invite" {
            assert_eq!(
                decide(&w, &a, &w.lead, "confirm", Some("confirm-1"))
                    .await
                    .body,
                done
            );
        }
        let conflict = decide(&w, &a, &w.lead, "confirm", Some("different")).await;
        assert_eq!(conflict.status, StatusCode::CONFLICT);
        assert_eq!(conflict.body["code"], "already_decided");
        assert_eq!(
            decide(&w, &a, &w.lead, "reject", None).await.body["code"],
            "already_decided"
        );
    }
    let a = propose(&ctx, "propose_receipt_confirm", json!({"receipt_id":r})).await;
    assert_eq!(count(&w, "purchase_lines").await, 0);
    let done = confirm(&w, &a).await;
    assert_eq!(done["result"]["receipt_id"], r.to_string());
    assert_eq!(values(&w, p).await.2, Some(7));
    assert_eq!(count(&w, "purchase_lines").await, 1);
    assert_eq!(
        decide(&w, &a, &w.lead, "confirm", Some("confirm-1"))
            .await
            .body,
        done
    );
    assert_eq!(count(&w, "stock_movements").await, 2);
    assert_eq!(count(&w, "expenses").await, 2);
    assert_eq!(w.events("assistant.action.confirmed").await, 8);
    assert_events(&w).await;
    for _ in 0..100 {
        if recording.0.lock().unwrap().len() >= 16 {
            break;
        }
        tokio::task::yield_now().await;
    }
    let events = recording.0.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event == "assistant_action_proposed")
            .count(),
        8
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event == "assistant_action_decided")
            .count(),
        8
    );
    assert!(
        events
            .iter()
            .all(|e| e.distinct_id == w.lead_id.to_string())
    );
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn stale_targets_and_expiry_commit_expired_without_writes() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let p = w.product("Sữa", 15000, None).await;
    for kind in [
        "price_change",
        "threshold_update",
        "stock_adjustment",
        "receipt_confirm",
        "receipt_line_update",
        "expense",
    ] {
        let (r, l) = receipt(&w, Some(p)).await;
        let args = match kind {
            "price_change" => json!({"product_id":p,"new_price":17000}),
            "threshold_update" => json!({"product_id":p,"threshold":7}),
            "stock_adjustment" => json!({"product_id":p,"delta":1,"reason":"Kiểm kê"}),
            "receipt_confirm" => json!({"receipt_id":r}),
            "receipt_line_update" => json!({"receipt_id":r,"line_id":l,"quantity":3}),
            _ => json!({"amount":1000,"category":"khac","note":"Chi","paid_with":"other"}),
        };
        let a = propose(&ctx, &format!("propose_{kind}"), args).await;
        match kind {
            "price_change" => {
                sqlx::query("UPDATE products SET price=16000 WHERE id=$1")
                    .bind(p)
                    .execute(w.pool())
                    .await
                    .unwrap();
            }
            "threshold_update" => {
                sqlx::query("UPDATE products SET low_stock_threshold=2 WHERE id=$1")
                    .bind(p)
                    .execute(w.pool())
                    .await
                    .unwrap();
            }
            "stock_adjustment" => {
                sqlx::query("UPDATE products SET archived=true WHERE id=$1")
                    .bind(p)
                    .execute(w.pool())
                    .await
                    .unwrap();
            }
            "receipt_confirm" => {
                sqlx::query("UPDATE receipts SET status='discarded' WHERE id=$1")
                    .bind(r)
                    .execute(w.pool())
                    .await
                    .unwrap();
            }
            "receipt_line_update" => {
                sqlx::query("UPDATE receipt_lines SET cost=1 WHERE id=$1")
                    .bind(l)
                    .execute(w.pool())
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query(
                    "UPDATE assistant_actions SET expires_at=now()-interval '1 second' WHERE id=$1",
                )
                .bind(id(&a))
                .execute(w.pool())
                .await
                .unwrap();
            }
        }
        let reply = decide(&w, &a, &w.lead, "confirm", Some("stale")).await;
        assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
        assert_eq!(reply.body["code"], "action_stale");
        let status: String = sqlx::query_scalar("SELECT status FROM assistant_actions WHERE id=$1")
            .bind(id(&a))
            .fetch_one(w.pool())
            .await
            .unwrap();
        assert_eq!(status, "expired");
        sqlx::query("UPDATE products SET archived=false WHERE id=$1")
            .bind(p)
            .execute(w.pool())
            .await
            .unwrap();
    }
    assert_eq!(count(&w, "stock_movements").await, 0);
    assert_eq!(count(&w, "expenses").await, 0);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn permission_ownership_rejection_and_missing_key() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let seller = context(&w, true).await;
    let registry = Registry::standard();
    let names: Vec<_> = registry
        .for_actor(&seller.actor)
        .iter()
        .map(|t| t.name())
        .collect();
    for hidden in [
        "propose_price_change",
        "propose_stock_adjustment",
        "propose_invite",
        "propose_threshold_update",
        "propose_receipt_confirm",
        "propose_receipt_line_update",
    ] {
        assert!(!names.contains(&hidden));
    }
    assert!(names.contains(&"propose_expense") && names.contains(&"propose_reorder_list"));
    let p = w.product("Sữa", 15000, None).await;
    let a = propose(
        &ctx,
        "propose_price_change",
        json!({"product_id":p,"new_price":17000}),
    )
    .await;
    assert_eq!(
        decide(&w, &a, &w.lead, "confirm", None).await.status,
        StatusCode::BAD_REQUEST
    );
    for decision in ["confirm", "reject"] {
        assert_eq!(
            decide(&w, &a, &w.seller, decision, Some("key"))
                .await
                .status,
            StatusCode::NOT_FOUND
        );
    }
    let other = World::new().await;
    assert_eq!(
        decide_in(&w, other.store_id, &a, &other.lead, "confirm", Some("key"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE members SET role='seller',can_enroll=false WHERE id=$1")
        .bind(w.lead_id)
        .execute(w.pool())
        .await
        .unwrap();
    let forbidden = decide(&w, &a, &w.lead, "confirm", Some("key")).await;
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
    assert_eq!(values(&w, p).await.0, 15000);
    let status: (String, Option<Uuid>, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT status,decided_by,idempotency_key_hash FROM assistant_actions WHERE id=$1",
    )
    .bind(id(&a))
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(status, ("proposed".into(), None, None));
    let rejected = decide(&w, &a, &w.lead, "reject", None).await;
    assert_eq!(rejected.body["status"], "rejected");
    assert_eq!(
        decide(&w, &a, &w.lead, "confirm", Some("key")).await.body["code"],
        "already_decided"
    );
    assert_eq!(
        decide(&w, &a, &w.lead, "reject", None).await.body["code"],
        "already_decided"
    );
    assert_eq!(w.events("assistant.action.rejected").await, 1);
    assert_events(&w).await;
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn handler_failure_and_unmatched_receipt_return_failed_action() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let p = w.product("Sữa", 15000, None).await;
    sqlx::query("UPDATE products SET stock_quantity=2147483647 WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    let a = propose(
        &ctx,
        "propose_stock_adjustment",
        json!({"product_id":p,"delta":1,"reason":"Kiểm kê"}),
    )
    .await;
    let failed = decide(&w, &a, &w.lead, "confirm", Some("fail")).await;
    assert_eq!(failed.status, StatusCode::OK);
    assert_eq!(failed.body["status"], "failed");
    assert_eq!(failed.body["error"]["code"], "validation_failed");
    assert!(
        failed.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("overflow")
    );
    assert_eq!(
        decide(&w, &a, &w.lead, "confirm", Some("fail")).await.body,
        failed.body
    );
    let (r, _) = receipt(&w, None).await;
    let a = propose(&ctx, "propose_receipt_confirm", json!({"receipt_id":r})).await;
    let failed = decide(&w, &a, &w.lead, "confirm", Some("unmatched")).await;
    assert_eq!(failed.status, StatusCode::OK);
    assert_eq!(failed.body["status"], "failed");
    assert_eq!(failed.body["error"]["code"], "receipt_unmatched_lines");
    assert_eq!(count(&w, "expenses").await, 0);
    assert_eq!(count(&w, "stock_movements").await, 0);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn invalid_arguments_and_missing_archived_targets() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let p = w.product("Sữa", 15000, None).await;
    let (r, l) = receipt(&w, Some(p)).await;
    let registry = Registry::standard();
    for (name, args) in [
        (
            "stock_adjustment",
            json!({"product_id":p,"delta":0,"reason":"x"}),
        ),
        (
            "stock_adjustment",
            json!({"product_id":p,"delta":1,"reason":"x".repeat(201)}),
        ),
        (
            "expense",
            json!({"amount":0,"category":"dien","note":"x","paid_with":"cash_box"}),
        ),
        (
            "expense",
            json!({"amount":1,"category":"nhap_hang","note":"x","paid_with":"cash_box"}),
        ),
        (
            "expense",
            json!({"amount":1,"category":"dien","note":"x","paid_with":"bank"}),
        ),
        ("price_change", json!({"product_id":p,"new_price":1.5})),
        (
            "threshold_update",
            json!({"product_id":p,"threshold":100001}),
        ),
        ("reorder_list", json!({"items":[]})),
        (
            "reorder_list",
            json!({"items":[{"product_id":p,"quantity":0}]}),
        ),
        ("receipt_line_update", json!({"receipt_id":r,"line_id":l})),
        (
            "receipt_line_update",
            json!({"receipt_id":r,"line_id":l,"cost":-1}),
        ),
        ("invite", json!({"role":"admin","can_enroll":true})),
    ] {
        let error = registry
            .run(&ctx, &format!("propose_{name}"), args)
            .await
            .unwrap_err();
        assert!(matches!(error, ToolError::InvalidArguments(_)), "{error}");
    }
    for (name, args) in [
        (
            "price_change",
            json!({"product_id":Uuid::new_v4(),"new_price":1}),
        ),
        ("receipt_confirm", json!({"receipt_id":Uuid::new_v4()})),
        (
            "receipt_line_update",
            json!({"receipt_id":r,"line_id":Uuid::new_v4(),"quantity":3}),
        ),
    ] {
        assert!(matches!(
            registry.run(&ctx, &format!("propose_{name}"), args).await,
            Err(ToolError::NotFound(_))
        ));
    }
    sqlx::query("UPDATE products SET archived=true WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    assert!(matches!(
        registry
            .run(
                &ctx,
                "propose_price_change",
                json!({"product_id":p,"new_price":1})
            )
            .await,
        Err(ToolError::NotFound(_))
    ));
    assert_eq!(count(&w, "assistant_actions").await, 0);
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn reorder_card_hides_costs_from_sellers() {
    let (w, _) = world().await;
    let seller = context(&w, true).await;
    let p = w.product("Sữa", 15000, Some(10000)).await;
    let out = Registry::standard()
        .run(
            &seller,
            "propose_reorder_list",
            json!({"items":[{"product_id":p,"quantity":2}]}),
        )
        .await
        .unwrap();
    let card = out.card.unwrap();
    assert!(Contract::load().schema_accepts("AssistantCard", &card));
    assert!(card["items"][0]["unit_cost"].is_null());
    assert!(card["total_cost"].is_null());
    let a = out.action.unwrap();
    let done = decide(&w, &a, &w.seller, "confirm", Some("reorder")).await;
    assert_eq!(done.body["status"], "done");
    assert!(done.body["result"]["total_cost"].is_null());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn concurrent_confirms_and_executing_crash_recovery_are_safe() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let a = propose(
        &ctx,
        "propose_expense",
        json!({"amount":1000,"category":"khac","note":"Chi","paid_with":"other"}),
    )
    .await;
    let (first, second) = tokio::join!(
        decide(&w, &a, &w.lead, "confirm", Some("race")),
        decide(&w, &a, &w.lead, "confirm", Some("race"))
    );
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.body, second.body);
    assert_eq!(count(&w, "expenses").await, 1);
    assert_eq!(w.events("assistant.action.confirmed").await, 1);
    // Simulate losing finalization after the downstream expense committed.
    sqlx::query("UPDATE assistant_actions SET status='executing',result=NULL WHERE id=$1")
        .bind(id(&a))
        .execute(w.pool())
        .await
        .unwrap();
    let recovered = decide(&w, &a, &w.lead, "confirm", Some("race")).await;
    assert_eq!(recovered.body, first.body);
    assert_eq!(count(&w, "expenses").await, 1);
    let invite = propose(
        &ctx,
        "propose_invite",
        json!({"role":"seller","can_enroll":false}),
    )
    .await;
    sqlx::query("UPDATE assistant_actions SET status='executing',decided_by=$2,decided_at=now(),idempotency_key_hash=$3 WHERE id=$1").bind(id(&invite)).bind(w.lead_id).bind(taphoa_api::idempotency::request_hash(&json!("recover")).as_slice()).execute(w.pool()).await.unwrap();
    let before = count(&w, "invites").await;
    let recovered = decide(&w, &invite, &w.lead, "confirm", Some("recover")).await;
    assert_eq!(recovered.status, StatusCode::OK);
    assert_eq!(recovered.body["status"], "failed");
    assert_eq!(recovered.body["error"]["code"], "invite_outcome_unknown");
    assert_eq!(count(&w, "invites").await, before);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn seller_owned_forged_price_action_is_denied_and_expired_reject_is_stale() {
    let (w, _) = world().await;
    let seller = context(&w, true).await;
    let p = w.product("Sữa", 15000, None).await;
    let action: Uuid = sqlx::query_scalar("INSERT INTO assistant_actions(store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,expires_at) VALUES($1,$2,$3,'price_change',$4,'Đổi giá',$5,now()+interval '24 hours') RETURNING id")
        .bind(w.store_id).bind(seller.thread_id).bind(seller.message_id)
        .bind(json!({"product_id":p,"old_price":15000,"new_price":17000})).bind(w.seller_id)
        .fetch_one(w.pool()).await.unwrap();
    let action = json!({"id":action});
    let reply = decide(&w, &action, &w.seller, "confirm", Some("forged")).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(values(&w, p).await.0, 15000);
    sqlx::query("UPDATE assistant_actions SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(id(&action))
        .execute(w.pool())
        .await
        .unwrap();
    let reply = decide(&w, &action, &w.seller, "reject", None).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body["code"], "action_stale");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn assistant_member_foreign_keys_allow_data_reset() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let proposer: Uuid = sqlx::query_scalar("INSERT INTO members(clerk_user_id,store_id,display_name,role) VALUES('fixture_' || gen_random_uuid()::text,$1,'Temporary','seller') RETURNING id")
        .bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    let decider: Uuid = sqlx::query_scalar("INSERT INTO members(clerk_user_id,store_id,display_name,role) VALUES('fixture_' || gen_random_uuid()::text,$1,'Temporary','lead') RETURNING id")
        .bind(w.store_id).fetch_one(w.pool()).await.unwrap();
    let action: Uuid = sqlx::query_scalar("INSERT INTO assistant_actions(store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,decided_by,expires_at) VALUES($1,$2,$3,'expense','{}','Chi phí',$4,$5,now()+interval '24 hours') RETURNING id")
        .bind(w.store_id).bind(ctx.thread_id).bind(ctx.message_id).bind(proposer).bind(decider)
        .fetch_one(w.pool()).await.unwrap();
    sqlx::query("DELETE FROM members WHERE id=$1")
        .bind(decider)
        .execute(w.pool())
        .await
        .unwrap();
    let remaining: Option<Uuid> =
        sqlx::query_scalar("SELECT decided_by FROM assistant_actions WHERE id=$1")
            .bind(action)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert!(remaining.is_none());
    sqlx::query("DELETE FROM members WHERE id=$1")
        .bind(proposer)
        .execute(w.pool())
        .await
        .unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM assistant_actions WHERE id=$1")
        .bind(action)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn regression_stock_delta_remains_valid_after_a_sale() {
    let (w, _) = world().await;
    let ctx = context(&w, false).await;
    let product = w.product("Sữa", 15000, None).await;
    sqlx::query("UPDATE products SET stock_quantity=10 WHERE id=$1")
        .bind(product)
        .execute(w.pool())
        .await
        .unwrap();
    let action = propose(
        &ctx,
        "propose_stock_adjustment",
        json!({
            "product_id":product,"delta":3,"reason":"Nhập bổ sung"
        }),
    )
    .await;
    assert_eq!(action["payload"]["current_stock"], 10);
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        common::world::sale_body(
            Uuid::now_v7(),
            &common::world::now_iso(),
            "cash",
            &[(product, 2, 15000)],
        ),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(values(&w, product).await.2, Some(8));
    let done = confirm(&w, &action).await;
    assert_eq!(values(&w, product).await.2, Some(11));
    assert_eq!(
        done["payload"]["current_stock"], 10,
        "snapshot is for display"
    );
    assert_eq!(
        decide(&w, &action, &w.lead, "confirm", Some("confirm-1"))
            .await
            .body,
        done
    );
    assert_eq!(count(&w, "stock_movements").await, 2);
}

struct CommittedDecisions {
    pool: sqlx::PgPool,
    events: Mutex<Vec<(CaptureEvent, bool)>>,
    ready: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl Analytics for CommittedDecisions {
    async fn capture_event(&self, event: CaptureEvent) -> anyhow::Result<()> {
        if event.event != "assistant_action_decided" {
            return Ok(());
        }
        let status = match event.properties["decision"].as_str() {
            Some("confirmed") => "done",
            Some("rejected") => "rejected",
            Some("failed") => "failed",
            Some("expired") => "expired",
            _ => anyhow::bail!("unexpected assistant decision"),
        };
        let committed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assistant_actions WHERE store_id=$1 AND kind=$2 AND status=$3)")
            .bind(event.groups["store"].as_str().unwrap().parse::<Uuid>()?)
            .bind(event.properties["kind"].as_str().unwrap()).bind(status)
            .fetch_one(&self.pool).await?;
        self.events.lock().unwrap().push((event, committed));
        self.ready.notify_one();
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn regression_every_decision_captures_its_committed_status_once() {
    for scenario in [
        "handler_failure",
        "invite_unknown",
        "confirm_changed",
        "confirm_elapsed",
        "reject_changed",
        "reject_elapsed",
        "confirmed",
        "rejected",
    ] {
        let (mut w, _) = world().await;
        let recording = Arc::new(CommittedDecisions {
            pool: w.pool().clone(),
            events: Mutex::new(Vec::new()),
            ready: tokio::sync::Notify::new(),
        });
        w.state.analytics = recording.clone();
        w.app = taphoa_api::router(w.state.clone());
        let ctx = context(&w, false).await;
        let product = w.product("Sữa", 15000, None).await;
        let (tool, args) = match scenario {
            "handler_failure" => {
                sqlx::query("UPDATE products SET stock_quantity=2147483647 WHERE id=$1")
                    .bind(product)
                    .execute(w.pool())
                    .await
                    .unwrap();
                (
                    "propose_stock_adjustment",
                    json!({"product_id":product,"delta":1,"reason":"Kiểm kê"}),
                )
            }
            "invite_unknown" => (
                "propose_invite",
                json!({"role":"seller","can_enroll":false}),
            ),
            "confirm_changed" | "reject_changed" => (
                "propose_price_change",
                json!({"product_id":product,"new_price":17000}),
            ),
            _ => (
                "propose_expense",
                json!({"amount":1000,"category":"khac","note":"Chi","paid_with":"other"}),
            ),
        };
        let action = propose(&ctx, tool, args).await;
        if scenario == "invite_unknown" {
            sqlx::query("UPDATE assistant_actions SET status='executing',decided_by=$2,decided_at=now(),idempotency_key_hash=$3 WHERE id=$1")
                .bind(id(&action)).bind(w.lead_id)
                .bind(taphoa_api::idempotency::request_hash(&json!("decision")).as_slice())
                .execute(w.pool()).await.unwrap();
        } else if scenario.ends_with("changed") {
            sqlx::query("UPDATE products SET price=16000 WHERE id=$1")
                .bind(product)
                .execute(w.pool())
                .await
                .unwrap();
        } else if scenario.ends_with("elapsed") {
            sqlx::query(
                "UPDATE assistant_actions SET expires_at=now()-interval '1 second' WHERE id=$1",
            )
            .bind(id(&action))
            .execute(w.pool())
            .await
            .unwrap();
        }
        let decision = if scenario.starts_with("reject") {
            "reject"
        } else {
            "confirm"
        };
        let expected = match scenario {
            "handler_failure" | "invite_unknown" => "failed",
            "confirmed" => "confirmed",
            "rejected" => "rejected",
            _ => "expired",
        };
        let reply = decide(&w, &action, &w.lead, decision, Some("decision")).await;
        if expected == "expired" {
            assert_eq!(
                reply.status,
                StatusCode::CONFLICT,
                "{scenario}: {}",
                reply.body
            );
            assert_eq!(reply.body["code"], "action_stale");
        } else {
            assert_eq!(reply.status, StatusCode::OK, "{scenario}: {}", reply.body);
            assert_eq!(
                reply.body["status"],
                if expected == "confirmed" {
                    "done"
                } else {
                    expected
                }
            );
        }
        tokio::time::timeout(Duration::from_secs(2), recording.ready.notified())
            .await
            .unwrap_or_else(|_| panic!("missing {expected} product event for {scenario}"));
        let replay = decide(&w, &action, &w.lead, decision, Some("decision")).await;
        if expected == "expired" {
            assert_eq!(replay.body["code"], "action_stale");
        } else if expected == "rejected" {
            assert_eq!(replay.body["code"], "already_decided");
        } else {
            assert_eq!(replay.body, reply.body);
        }
        let events = recording.events.lock().unwrap();
        assert_eq!(events.len(), 1, "{scenario}");
        assert_eq!(events[0].0.properties["decision"], expected, "{scenario}");
        assert_eq!(
            events[0].0.properties["kind"],
            tool.trim_start_matches("propose_")
        );
        assert_eq!(events[0].0.distinct_id, w.lead_id.to_string());
        assert!(
            events[0].1,
            "decision must be committed before analytics capture: {scenario}"
        );
    }
}
