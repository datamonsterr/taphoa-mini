//! X5-T6: debt tools, proposals and the overdue_debts next step against the real router.
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
use taphoa_api::{
    assistant::{
        Language,
        tools::{Registry, ToolContext, ToolError},
    },
    auth::{Actor, Role},
};
use tower::ServiceExt;
use uuid::Uuid;

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
    let message = sqlx::query_scalar("INSERT INTO assistant_messages(thread_id,store_id,role,content) VALUES($1,$2,'assistant','Đề xuất') RETURNING id").bind(thread).bind(w.store_id).fetch_one(w.pool()).await.unwrap();
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
        trace_id: None,
    }
}
/// A customer with a balance whose oldest debt is `age` days before the tool date (2026-10-25).
async fn customer(w: &World, name: &str, phone: &str, balance: i64, age: i64) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO customers(id,store_id,name,phone,balance,oldest_debt_date,request_hash) VALUES($1,$2,$3,$4,$5,CASE WHEN $5>0 THEN '2026-10-25'::date-$6::int END,'\\x00')")
        .bind(id).bind(w.store_id).bind(name).bind(phone).bind(balance).bind(age as i32).execute(w.pool()).await.unwrap();
    id
}
async fn run(
    ctx: &ToolContext,
    name: &str,
    args: Value,
) -> taphoa_api::assistant::tools::ToolOutput {
    Registry::standard().run(ctx, name, args).await.unwrap()
}
async fn decide(w: &World, id: &str, token: &str, key: &str) -> Reply {
    let res = w
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/assistant/actions/{id}/confirm"))
                .header("authorization", format!("Bearer {token}"))
                .header("x-store-id", w.store_id.to_string())
                .header("x-forwarded-for", "10.97.1.2")
                .header("idempotency-key", key)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let raw = to_bytes(res.into_body(), 8 << 20).await.unwrap().to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Reply {
        status,
        body,
        headers,
        raw,
    }
}
async fn entries(w: &World, customer: Uuid) -> Vec<(Uuid, String, i64, i64)> {
    sqlx::query_as("SELECT id,kind,amount,balance_after FROM debt_entries WHERE store_id=$1 AND customer_id=$2 ORDER BY created_at")
        .bind(w.store_id).bind(customer).fetch_all(w.pool()).await.unwrap()
}
async fn balance(w: &World, customer: Uuid) -> i64 {
    sqlx::query_scalar("SELECT balance FROM customers WHERE id=$1")
        .bind(customer)
        .fetch_one(w.pool())
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn get_debts_filters_totals_and_card() {
    let w = World::new().await;
    let ctx = context(&w, false).await;
    let old = customer(&w, "Chị Lan", "0901111222", 300_000, 10).await;
    let _new = customer(&w, "Anh Bình", "0903333444", 100_000, 2).await;
    customer(&w, "Đã trả", "0905555666", 0, 0).await;
    let archived = customer(&w, "Cũ", "0907777888", 50_000, 30).await;
    sqlx::query("UPDATE customers SET archived_at=now() WHERE id=$1")
        .bind(archived)
        .execute(w.pool())
        .await
        .unwrap();

    let all = run(&ctx, "get_debts", json!({})).await;
    assert_eq!(all.data["total_outstanding"], 400_000);
    assert_eq!(all.data["customer_count"], 2);
    assert_eq!(all.data["truncated"], false);
    let rows = all.data["customers"].as_array().unwrap();
    assert_eq!(rows[0]["customer_id"], old.to_string());
    assert_eq!(rows[0]["debt_age_days"], 10);
    assert_eq!(rows[0]["overdue"], true);
    assert_eq!(rows[1]["overdue"], false);
    assert_eq!((all.rows, all.truncated), (2, false));
    let card = all.card.unwrap();
    assert!(
        Contract::load().schema_accepts("AssistantCard", &card),
        "{card}"
    );
    assert_eq!(card["type"], "debt_list");
    assert_eq!(card["items"][0]["overdue_days"], 10);

    let by_phone = run(&ctx, "get_debts", json!({"customer_query":"0903"})).await;
    assert_eq!(by_phone.data["customers"].as_array().unwrap().len(), 1);
    let by_name = run(&ctx, "get_debts", json!({"customer_query":"lan"})).await;
    assert_eq!(by_name.data["customers"][0]["name"], "Chị Lan");
    let aged = run(&ctx, "get_debts", json!({"overdue_days":5})).await;
    assert_eq!(aged.data["customers"].as_array().unwrap().len(), 1);
    assert_eq!(aged.data["total_outstanding"], 300_000);
    let none = run(&ctx, "get_debts", json!({"customer_query":"zzz"})).await;
    assert!(none.card.is_none() && none.data["customer_count"] == 0);

    // A seller reads the debt book too (RecordDebt).
    let seller = context(&w, true).await;
    assert_eq!(
        run(&seller, "get_debts", json!({})).await.data["customer_count"],
        2
    );
    assert!(matches!(
        Registry::standard()
            .run(&ctx, "get_debts", json!({"overdue_days":-1}))
            .await,
        Err(ToolError::InvalidArguments(_))
    ));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn get_debts_truncates_at_fifty_rows() {
    let w = World::new().await;
    let ctx = context(&w, false).await;
    for n in 0..52 {
        customer(&w, &format!("Khách {n}"), "0900000000", 1000 + n, 1).await;
    }
    let out = run(&ctx, "get_debts", json!({})).await;
    assert_eq!(out.data["customers"].as_array().unwrap().len(), 50);
    assert!(out.truncated && out.data["truncated"] == true);
    assert_eq!(out.data["customer_count"], 52);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn reminder_text_with_and_without_bank_and_for_zero_balance() {
    let w = World::new().await;
    let ctx = context(&w, false).await;
    let owes = customer(&w, "Chị Lan", "0901111222", 150_000, 3).await;
    let paid = customer(&w, "Anh Bình", "0903333444", 0, 0).await;
    let plain = run(&ctx, "draft_debt_reminder", json!({"customer_id":owes})).await;
    assert_eq!(
        plain.data["reminder_vi"],
        "Chào Chị Lan, Tạp hóa E4 xin nhắc khoản nợ còn lại của bạn là 150.000đ.\nCảm ơn bạn!"
    );
    sqlx::query("UPDATE stores SET bank_bin='970436',bank_short_name='VCB',bank_account_number='0123456789',bank_account_name='NGUYEN VAN A' WHERE id=$1")
        .bind(w.store_id).execute(w.pool()).await.unwrap();
    let bank = run(&ctx, "draft_debt_reminder", json!({"customer_id":owes})).await;
    assert_eq!(
        bank.data["reminder_vi"],
        "Chào Chị Lan, Tạp hóa E4 xin nhắc khoản nợ còn lại của bạn là 150.000đ.\nBạn có thể chuyển khoản: VCB - 0123456789 - NGUYEN VAN A\nNội dung chuyển khoản: TRA NO CHI LAN\nCảm ơn bạn!"
    );
    let none = run(&ctx, "draft_debt_reminder", json!({"customer_id":paid})).await;
    assert!(none.data["reminder_vi"].is_null());
    assert!(matches!(
        Registry::standard()
            .run(
                &ctx,
                "draft_debt_reminder",
                json!({"customer_id":Uuid::new_v4()})
            )
            .await,
        Err(ToolError::NotFound(_))
    ));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn seller_tool_list_excludes_adjustment() {
    let w = World::new().await;
    let seller = context(&w, true).await.actor;
    let lead = context(&w, false).await.actor;
    let names = |actor: &Actor| -> Vec<String> {
        Registry::standard()
            .specs_for(actor)
            .into_iter()
            .map(|s| s.name)
            .collect()
    };
    let seller_names = names(&seller);
    for tool in ["get_debts", "draft_debt_reminder", "propose_repayment"] {
        assert!(seller_names.iter().any(|n| n == tool), "{tool}");
    }
    assert!(!seller_names.iter().any(|n| n == "propose_debt_adjustment"));
    assert!(names(&lead).iter().any(|n| n == "propose_debt_adjustment"));
    let ctx = context(&w, true).await;
    let c = customer(&w, "A", "1", 1000, 1).await;
    assert!(matches!(
        Registry::standard()
            .run(
                &ctx,
                "propose_debt_adjustment",
                json!({"customer_id":c,"amount":-1000,"reason":"xóa nợ"})
            )
            .await,
        Err(ToolError::Denied)
    ));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn repayment_proposes_without_writing_and_confirms_once() {
    let w = World::new().await;
    let ctx = context(&w, false).await;
    let c = customer(&w, "Chị Lan", "0901111222", 300_000, 10).await;
    let out = run(
        &ctx,
        "propose_repayment",
        json!({"customer_id":c,"amount":120_000,"method":"transfer"}),
    )
    .await;
    let action = out.action.unwrap();
    assert!(
        Contract::load().schema_accepts("AssistantAction", &action),
        "{action}"
    );
    assert_eq!(
        (action["kind"].as_str(), action["status"].as_str()),
        (Some("repayment"), Some("proposed"))
    );
    assert!(entries(&w, c).await.is_empty());
    assert_eq!(balance(&w, c).await, 300_000);

    let id = action["id"].as_str().unwrap();
    let first = decide(&w, id, &w.lead, "k1").await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(first.body["status"], "done", "{}", first.body);
    let rows = entries(&w, c).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].1.as_str(), rows[0].2, rows[0].3),
        ("repayment", -120_000, 180_000)
    );
    assert_eq!(first.body["result"]["entry_id"], rows[0].0.to_string());
    assert_eq!(balance(&w, c).await, 180_000);

    // Replay with the same key returns the same result and writes nothing; another key is refused.
    let replay = decide(&w, id, &w.lead, "k1").await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.body["result"], first.body["result"]);
    assert_eq!(entries(&w, c).await.len(), 1);
    assert_eq!(
        decide(&w, id, &w.lead, "k2").await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(entries(&w, c).await.len(), 1);

    // The ledger entry is idempotent by the action id even if the action is recovered.
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM debt_entries WHERE store_id=$1 AND key_hash IS NOT NULL",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(stored, 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn seller_may_confirm_repayment_but_not_adjustment() {
    let w = World::new().await;
    let seller = context(&w, true).await;
    let c = customer(&w, "Chị Lan", "0901111222", 300_000, 10).await;
    let out = run(
        &seller,
        "propose_repayment",
        json!({"customer_id":c,"amount":50_000,"method":"cash"}),
    )
    .await;
    let id = out.action.unwrap()["id"].as_str().unwrap().to_owned();
    let done = decide(&w, &id, &w.seller, "s1").await;
    assert_eq!(done.body["status"], "done", "{}", done.body);
    assert_eq!(balance(&w, c).await, 250_000);

    // A seller cannot propose an adjustment; a row planted for them is refused at confirm.
    let adjustment = Uuid::now_v7();
    sqlx::query("INSERT INTO assistant_actions(id,store_id,thread_id,message_id,kind,payload,summary_vi,proposed_by,expires_at) VALUES($1,$2,$3,$4,'debt_adjustment',$5,'Điều chỉnh',$6,now()+interval '1 hour')")
        .bind(adjustment).bind(w.store_id).bind(seller.thread_id).bind(seller.message_id)
        .bind(json!({"customer_id":c,"customer_name":"Chị Lan","amount":-250_000,"reason":"xóa nợ","balance_before":250_000}))
        .bind(w.seller_id).execute(w.pool()).await.unwrap();
    let denied = decide(&w, &adjustment.to_string(), &w.seller, "s2").await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);
    assert_eq!(balance(&w, c).await, 250_000);
    assert_eq!(entries(&w, c).await.len(), 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn lead_adjustment_confirms_once_with_signed_amount() {
    let w = World::new().await;
    let ctx = context(&w, false).await;
    let c = customer(&w, "Chị Lan", "0901111222", 300_000, 10).await;
    for args in [
        json!({"customer_id":c,"amount":0,"reason":"x"}),
        json!({"customer_id":c,"amount":5,"reason":"   "}),
        json!({"customer_id":c,"amount":5,"reason":"x".repeat(201)}),
    ] {
        assert!(matches!(
            Registry::standard()
                .run(&ctx, "propose_debt_adjustment", args)
                .await,
            Err(ToolError::InvalidArguments(_))
        ));
    }
    let out = run(
        &ctx,
        "propose_debt_adjustment",
        json!({"customer_id":c,"amount":-300_000,"reason":"Xóa nợ khó đòi"}),
    )
    .await;
    let action = out.action.unwrap();
    assert!(
        Contract::load().schema_accepts("AssistantAction", &action),
        "{action}"
    );
    assert_eq!(action["kind"], "debt_adjustment");
    assert!(entries(&w, c).await.is_empty());
    let id = action["id"].as_str().unwrap();
    let done = decide(&w, id, &w.lead, "a1").await;
    assert_eq!(done.body["status"], "done", "{}", done.body);
    let rows = entries(&w, c).await;
    assert_eq!(
        (rows.len(), rows[0].1.as_str(), rows[0].2, rows[0].3),
        (1, "adjustment", -300_000, 0)
    );
    assert_eq!(
        decide(&w, id, &w.lead, "a1").await.body["result"],
        done.body["result"]
    );
    assert_eq!(entries(&w, c).await.len(), 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn archived_customer_makes_proposal_stale() {
    let w = World::new().await;
    let ctx = context(&w, false).await;
    let c = customer(&w, "Chị Lan", "0901111222", 300_000, 10).await;
    let out = run(
        &ctx,
        "propose_repayment",
        json!({"customer_id":c,"amount":10_000,"method":"cash"}),
    )
    .await;
    let id = out.action.unwrap()["id"].as_str().unwrap().to_owned();
    sqlx::query("UPDATE customers SET archived_at=now() WHERE id=$1")
        .bind(c)
        .execute(w.pool())
        .await
        .unwrap();
    let stale = decide(&w, &id, &w.lead, "z1").await;
    assert_eq!(stale.status, StatusCode::CONFLICT, "{}", stale.body);
    assert_eq!(stale.body["code"], "action_stale");
    assert!(entries(&w, c).await.is_empty());
    assert!(matches!(
        Registry::standard()
            .run(
                &ctx,
                "propose_repayment",
                json!({"customer_id":c,"amount":1,"method":"cash"})
            )
            .await,
        Err(ToolError::NotFound(_))
    ));
    assert!(matches!(
        Registry::standard()
            .run(
                &ctx,
                "propose_repayment",
                json!({"customer_id":Uuid::new_v4(),"amount":1,"method":"cash"})
            )
            .await,
        Err(ToolError::NotFound(_))
    ));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn overdue_debts_next_step_needs_an_overdue_customer() {
    let w = World::new().await;
    let steps = |token: String| {
        let w = &w;
        async move {
            let r = w
                .call(
                    "GET",
                    "/v1/assistant/next-steps?screen=home",
                    &token,
                    Value::Null,
                )
                .await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.body);
            Contract::load().assert_conforms("/v1/assistant/next-steps", "get", r.status, &r.body);
            r.body["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["kind"] == "overdue_debts")
                .cloned()
        }
    };
    assert!(steps(w.lead.clone()).await.is_none());
    // Owing for exactly 7 days is not overdue; the rule counts only older debts.
    let today = taphoa_api::time::business_date(chrono::Utc::now());
    let fresh = Uuid::now_v7();
    sqlx::query("INSERT INTO customers(id,store_id,name,balance,oldest_debt_date,request_hash) VALUES($1,$2,'Mới',5000,$3::date-7,'\\x00')")
        .bind(fresh).bind(w.store_id).bind(today).execute(w.pool()).await.unwrap();
    assert!(steps(w.lead.clone()).await.is_none());
    sqlx::query("INSERT INTO customers(id,store_id,name,balance,oldest_debt_date,request_hash) VALUES($1,$2,'Cũ',9000,$3::date-8,'\\x00')")
        .bind(Uuid::now_v7()).bind(w.store_id).bind(today).execute(w.pool()).await.unwrap();
    for token in [w.lead.clone(), w.seller.clone()] {
        let step = steps(token).await.expect("overdue chip");
        assert_eq!(step["action"], json!({"type":"navigate","route":"/debts"}));
        assert_eq!(step["subtitle_vi"], "1 khách nợ quá 7 ngày");
    }
}
