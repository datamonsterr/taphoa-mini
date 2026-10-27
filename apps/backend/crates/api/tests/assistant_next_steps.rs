mod common;
use axum::http::StatusCode;
use common::{Contract, world::World};
use serde_json::Value;

const PATH: &str = "/v1/assistant/next-steps";

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn flags_contract_and_permissions() {
    let w = World::new().await;
    for (token, expected) in [
        (&w.lead, vec!["receipt_detected", "unknown_product"]),
        (&w.seller, vec![]),
    ] {
        let reply = w
            .call(
                "GET",
                &format!("{PATH}?screen=camera&document_detected=true&unknown_product=true"),
                token,
                Value::Null,
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        Contract::load().assert_conforms(PATH, "get", reply.status, &reply.body);
        let items = reply.body["items"].as_array().unwrap();
        assert!(items.len() <= 8);
        assert_eq!(
            items
                .iter()
                .take(expected.len())
                .map(|v| v["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(
            items
                .windows(2)
                .all(|p| p[0]["priority"].as_i64() <= p[1]["priority"].as_i64())
        );
        if token == &w.seller {
            assert!(items.is_empty());
        }
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn screen_required_and_boolean_queries_validated() {
    let w = World::new().await;
    for query in [
        "",
        "?screen=",
        "?screen=%20",
        "?screen=camera&document_detected=no",
        "?screen=camera&unknown_product=1",
    ] {
        let reply = w
            .call("GET", &format!("{PATH}{query}"), &w.lead, Value::Null)
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        Contract::load().assert_conforms(PATH, "get", reply.status, &reply.body);
    }
}

async fn receipt(w: &World, product: uuid::Uuid, status: &str, days: i32, cost: i64) {
    let image = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose) VALUES ($1,$2,$3,'image/jpeg',10,'expense_receipt')")
        .bind(image).bind(w.store_id).bind(format!("test/{image}")).execute(w.pool()).await.unwrap();
    let id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO receipts (id,store_id,member_id,image_id,status,ocr_text,parser,request_hash,confirmed_at) VALUES ($1,$2,$3,$4,$5,'','fallback','\\x00',now()-make_interval(days=>$6))")
        .bind(id).bind(w.store_id).bind(w.lead_id).bind(image).bind(status).bind(days).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO receipt_lines (receipt_id,store_id,position,raw_text,product_name,quantity,cost,product_id) VALUES ($1,$2,0,'','Hàng',1,$3,$4)")
        .bind(id).bind(w.store_id).bind(cost).bind(product).execute(w.pool()).await.unwrap();
}
async fn fixtures(w: &World) {
    let p = w.product("Hàng cần nhập", 100, None).await;
    sqlx::query("UPDATE products SET stock_quantity=5 WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    receipt(w, p, "draft", 0, 96).await;
    receipt(w, p, "confirmed", 1, 96).await;
    let sale = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO sales (id,store_id,code,member_id,sold_at,business_date,payment_method,total,request_hash) VALUES ($1,$2,'ABC123',$3,now(),current_date,'cash',100,'\\x00')")
        .bind(sale).bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO sale_lines (id,store_id,sale_id,position,source,quantity,unit_price,review_status) VALUES ($1,$2,$3,0,'manual',1,100,'open')")
        .bind(uuid::Uuid::now_v7()).bind(w.store_id).bind(sale).execute(w.pool()).await.unwrap();
}
fn kinds(body: &Value) -> Vec<&str> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["kind"].as_str().unwrap())
        .collect()
}
async fn list(w: &World, token: &str, flags: &str) -> Value {
    w.checked(
        "GET",
        &format!("{PATH}?screen=camera{flags}"),
        PATH,
        token,
        Value::Null,
        StatusCode::OK,
    )
    .await
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sql_rules_counts_order_stable_ids_and_store_isolation() {
    let w = World::new().await;
    fixtures(&w).await;
    let flags = "&document_detected=true&unknown_product=true";
    let body = list(&w, &w.lead, flags).await;
    let ks = kinds(&body);
    assert_eq!(&ks[..3], ["receipt_detected", "unknown_product", "restock"]);
    for kind in ["draft_receipts", "margin_alert", "review_queue", "setup"] {
        assert!(ks.contains(&kind), "{body}");
    }
    assert_eq!(body, list(&w, &w.lead, flags).await);
    for kind in ["restock", "draft_receipts", "review_queue", "margin_alert"] {
        let chip = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["kind"] == kind)
            .unwrap();
        assert!(chip["subtitle_vi"].as_str().unwrap().contains('1'));
    }
    assert_eq!(
        body["items"][0]["action"]["context"],
        serde_json::json!({"screen":"camera"})
    );
    assert_eq!(
        body["items"][2]["action"]["context"],
        serde_json::json!({"screen":"camera","next_step_id":"restock"})
    );
    assert_eq!(kinds(&list(&w, &w.seller, flags).await), ["restock"]);
    sqlx::query("UPDATE members SET can_enroll=true WHERE id=$1")
        .bind(w.seller_id)
        .execute(w.pool())
        .await
        .unwrap();
    assert_eq!(
        kinds(&list(&w, &w.seller, flags).await),
        [
            "receipt_detected",
            "unknown_product",
            "restock",
            "draft_receipts"
        ]
    );
    let other = World::new().await;
    assert_eq!(
        kinds(&list(&other, &other.lead, "").await)
            .into_iter()
            .filter(|k| *k != "day_close")
            .collect::<Vec<_>>(),
        ["setup"]
    );
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn performance_300_products_2000_sales_50_router_calls() {
    let w = World::new().await;
    fixtures(&w).await;
    sqlx::query("INSERT INTO products (id,store_id,name,price,stock_quantity,request_hash,created_by) SELECT gen_random_uuid(),$1,'Hàng '||n,100,3,'\\x00',$2 FROM generate_series(1,299) n")
        .bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO sales (id,store_id,code,member_id,sold_at,business_date,payment_method,total,request_hash) SELECT gen_random_uuid(),$1,'S'||n,$2,now()-make_interval(days=>n%60),current_date-n%60,'cash',100,'\\x00' FROM generate_series(1,2000) n")
        .bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    let path = format!("{PATH}?screen=camera");
    for _ in 0..5 {
        let reply = w.call("GET", &path, &w.lead, Value::Null).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    }
    let budget = std::time::Duration::from_millis(50);
    let mut batch_p95s = Vec::new();
    for batch in 1..=3 {
        let mut times = Vec::new();
        for _ in 0..50 {
            let start = std::time::Instant::now();
            let reply = w.call("GET", &path, &w.lead, Value::Null).await;
            times.push(start.elapsed());
            assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        }
        times.sort();
        let p95 = times[47];
        eprintln!("next-steps batch {batch} p95: {p95:?}");
        batch_p95s.push(p95);
        if p95 < budget {
            return;
        }
    }
    if std::env::var("CI_SLOW").as_deref() != Ok("1") {
        assert!(
            batch_p95s.iter().any(|p95| *p95 < budget),
            "no batch p95 below {budget:?}: {batch_p95s:?}"
        );
    }
}

async fn fixed_rules(w: &World, clock: &str) -> Value {
    use taphoa_api::{
        assistant::next_steps::{RuleInput, rank, rules},
        auth::{Actor, Role},
    };
    let now_local = chrono::NaiveDateTime::parse_from_str(clock, "%Y-%m-%d %H:%M:%S").unwrap();
    let actor = Actor {
        member_id: w.lead_id,
        store_id: w.store_id,
        clerk_user_id: "user_test".into(),
        clerk_session_id: "sess_test".into(),
        role: Role::Lead,
        can_enroll: true,
    };
    let input = RuleInput {
        today: now_local.date(),
        now_local,
        screen: "camera".into(),
    };
    let mut items = Vec::new();
    for rule in rules() {
        items.extend(rule(w.pool(), &actor, &input).await.unwrap());
    }
    let body = serde_json::json!({"items":rank(items, &actor)});
    Contract::load().assert_conforms(PATH, "get", StatusCode::OK, &body);
    body
}
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn rule_boundaries_and_day_close_suppression() {
    let w = World::new().await;
    let p = w.product("Ngưỡng riêng", 100, None).await;
    let q = w.product("Chưa theo dõi", 100, None).await;
    sqlx::query("UPDATE stores SET created_at='2026-10-12T13:00:00Z' WHERE id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE products SET stock_quantity=6,low_stock_threshold=6 WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    receipt(&w, p, "confirmed", 0, 190).await;
    // Receipt totals are divided by quantity and rounded up, just as confirmation does.
    sqlx::query("UPDATE receipts SET confirmed_at='2026-10-19T13:00:00Z' WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE receipt_lines SET quantity=2 WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    let before = fixed_rules(&w, "2026-10-26 19:59:00").await;
    assert_eq!(kinds(&before), ["restock", "setup"]);
    let at = fixed_rules(&w, "2026-10-26 20:00:00").await;
    assert_eq!(kinds(&at), ["restock", "day_close", "setup"]);
    assert_eq!(at["items"][1]["id"], "day_close:2026-10-26");
    assert_eq!(at["items"][1]["action"]["route"], "/close");
    sqlx::query("UPDATE receipt_lines SET cost=191 WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    assert!(kinds(&fixed_rules(&w, "2026-10-26 20:00:00").await).contains(&"margin_alert"));
    assert!(!kinds(&fixed_rules(&w, "2026-10-26 20:00:01").await).contains(&"margin_alert"));
    // An older store no longer gets setup, and today's close suppresses the chip.
    sqlx::query("INSERT INTO day_closes (store_id,business_date,cash_sales,cash_refunds,cash_expenses,expected_cash,counted_cash,transfer_revenue,closed_by) VALUES ($1,'2026-10-26',0,0,0,0,0,0,$2)")
        .bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    assert_eq!(
        kinds(&fixed_rules(&w, "2026-10-26 20:00:01").await),
        ["restock"]
    );
    sqlx::query("UPDATE products SET stock_quantity=7 WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE products SET low_stock_threshold=100 WHERE id=$1")
        .bind(q)
        .execute(w.pool())
        .await
        .unwrap();
    assert!(kinds(&fixed_rules(&w, "2026-10-26 20:00:01").await).is_empty());
    sqlx::query("UPDATE products SET stock_quantity=0,archived=true WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    assert!(kinds(&fixed_rules(&w, "2026-10-26 20:00:01").await).is_empty());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn setup_checklist_and_inactive_members() {
    let w = World::new().await;
    sqlx::query("UPDATE stores SET created_at='2026-10-25T13:00:00Z',bank_bin='970436',bank_account_number='1234',bank_account_name='Test' WHERE id=$1")
        .bind(w.store_id).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO day_closes (store_id,business_date,cash_sales,cash_refunds,cash_expenses,expected_cash,counted_cash,transfer_revenue,closed_by) VALUES ($1,'2026-10-25',0,0,0,0,0,0,$2)")
        .bind(w.store_id).bind(w.lead_id).execute(w.pool()).await.unwrap();
    assert!(kinds(&fixed_rules(&w, "2026-10-26 19:59:00").await).is_empty());
    sqlx::query("UPDATE members SET active=false WHERE id=$1")
        .bind(w.seller_id)
        .execute(w.pool())
        .await
        .unwrap();
    let body = fixed_rules(&w, "2026-10-26 19:59:00").await;
    assert_eq!(kinds(&body), ["setup"]);
    assert!(
        body["items"][0]["subtitle_vi"]
            .as_str()
            .unwrap()
            .starts_with('1')
    );
    let reply = common::world::send(
        &w.app,
        "GET",
        &format!("{PATH}?screen=camera"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}
