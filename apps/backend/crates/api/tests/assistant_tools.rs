//! The one T1 tool, `get_store_overview`, through the registry against real Postgres.
mod common;
use common::world::{World, now_iso, sale_body};
use serde_json::{Value, json};
use taphoa_api::{
    AppState,
    assistant::{
        Language,
        tools::{Registry, ToolContext, ToolError},
    },
    auth::{Actor, Role},
    time::business_date,
};
use uuid::Uuid;

fn context(w: &World, member: Uuid, role: Role) -> ToolContext {
    ToolContext {
        state: AppState {
            postgres: w.state.postgres.clone(),
            ..AppState::default()
        },
        actor: Actor {
            member_id: member,
            store_id: w.store_id,
            session_id: Uuid::nil(),
            role,
            can_enroll: role == Role::Lead,
        },
        today: business_date(chrono::Utc::now()),
        language: Language::Vi,
        thread_id: Uuid::now_v7(),
        message_id: Uuid::now_v7(),
        trace_id: None,
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn store_overview_counts_the_callers_store_for_today() {
    let w = World::new().await;
    let registry = Registry::standard();
    let cola = w.product("Coca lon", 10_000, Some(7_000)).await;
    let noodles = w.product("Mì Hảo Hảo", 4_000, None).await;
    let archived = w.product("Cũ", 1_000, None).await;
    sqlx::query("UPDATE products SET archived=true WHERE id=$1")
        .bind(archived)
        .execute(w.pool())
        .await
        .unwrap();
    // Tracked: cola is at its own threshold (low), noodles far above the store default of 5.
    for (product, stock, threshold) in [(cola, 3, Some(3)), (noodles, 100, None)] {
        sqlx::query("UPDATE products SET stock_quantity=$2, low_stock_threshold=$3 WHERE id=$1")
            .bind(product)
            .bind(stock)
            .bind(threshold)
            .execute(w.pool())
            .await
            .unwrap();
    }
    let mut sales = Vec::new();
    for lines in [[(cola, 2, 10_000)], [(cola, 1, 10_000)]] {
        let body = sale_body(Uuid::now_v7(), &now_iso(), "cash", &lines);
        let reply = w.call("POST", "/v1/sales", &w.seller, body).await;
        assert!(reply.status.is_success(), "{}", reply.body);
        sales.push(reply.body["id"].as_str().unwrap().to_owned());
    }
    // A voided sale and another store's sale stay out of the totals.
    let voided = sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(noodles, 5, 4_000)]);
    let reply = w.call("POST", "/v1/sales", &w.seller, voided).await;
    sqlx::query("UPDATE sales SET status='voided', voided_at=now() WHERE id=$1")
        .bind(reply.body["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(w.pool())
        .await
        .unwrap();
    let other = World::new().await;
    other.product("Khác", 1_000, None).await;

    // Both roles may call it: no permission is required.
    for (member, role) in [(w.lead_id, Role::Lead), (w.seller_id, Role::Seller)] {
        let ctx = context(&w, member, role);
        let output = registry
            .run(&ctx, "get_store_overview", json!({}))
            .await
            .unwrap();
        assert_eq!(
            output.data,
            json!({
                "store_name": "Tạp hóa E4",
                "member_count": 2,
                "product_count": 2,
                "low_stock_count": 1,
                "today": {"date": ctx.today, "sale_count": 2, "revenue": 30_000},
            })
        );
        assert!(
            output.summary_vi.contains("30.000 ₫"),
            "{}",
            output.summary_vi
        );
        assert!(output.card.is_none() && output.action.is_none());
    }

    // `today` comes from the context, not the clock: another day has no sales.
    let mut ctx = context(&w, w.lead_id, Role::Lead);
    ctx.today = ctx.today.succ_opt().unwrap();
    let output = registry
        .run(&ctx, "get_store_overview", json!({}))
        .await
        .unwrap();
    assert_eq!(output.data["today"]["sale_count"], 0);
    assert_eq!(output.data["today"]["revenue"], 0);
    assert_eq!(output.data["product_count"], 2);

    // Arguments must still be an object; and the registry lists the tool for a seller.
    assert!(matches!(
        registry.run(&ctx, "get_store_overview", Value::Null).await,
        Err(ToolError::InvalidArguments(_))
    ));
    let seller = context(&w, w.seller_id, Role::Seller).actor;
    let specs = registry.specs_for(&seller);
    assert!(specs.iter().any(|spec| spec.name == "get_store_overview"));
}
