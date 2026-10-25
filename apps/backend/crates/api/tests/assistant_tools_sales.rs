//! Deterministic real-database proof for the assistant's sales and stock definitions.
mod common;

use chrono::{Duration, NaiveDate};
use common::{Contract, world::World};
use serde_json::{Value, json};
use taphoa_api::{
    assistant::{
        Language,
        tools::{Registry, ToolContext, ToolError, ToolOutput},
    },
    auth::{Actor, Role},
};
use uuid::Uuid;

struct Fixture {
    world: World,
    active: Uuid,
    dead: Uuid,
}
impl Fixture {
    async fn new() -> Self {
        let world = World::new().await;
        let active = world.product("Mì Hảo Hảo", 10_000, Some(6_000)).await;
        let dead = world.product("Bánh tồn", 10_000, Some(9_600)).await;
        sqlx::query("UPDATE products SET stock_quantity=CASE WHEN id=$2 THEN 3 ELSE 7 END,low_stock_threshold=5 WHERE store_id=$1")
            .bind(world.store_id).bind(active).execute(world.pool()).await.unwrap();
        // Two base units every day, including days with a packaged sale.
        for offset in 0..56 {
            let day = today() - Duration::days(offset);
            let sale = Uuid::new_v4();
            sqlx::query("INSERT INTO sales (id,store_id,code,member_id,sold_at,business_date,payment_method,total,request_hash) VALUES ($1,$2,$3,$4,($5::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'),$5,'cash',20000,'\\x00')")
                .bind(sale).bind(world.store_id).bind(sale.to_string()).bind(world.lead_id).bind(day).execute(world.pool()).await.unwrap();
            sqlx::query("INSERT INTO sale_lines (id,store_id,sale_id,position,product_id,source,quantity,unit_price,quantity_in_base) VALUES ($1,$2,$3,0,$4,'grid',1,20000,2)")
                .bind(Uuid::new_v4()).bind(world.store_id).bind(sale).bind(active).execute(world.pool()).await.unwrap();
            if offset == 0 {
                sqlx::query("INSERT INTO sale_lines (id,store_id,sale_id,position,source,quantity,unit_price,manual_label) VALUES ($1,$2,$3,1,'manual',1,3000,'Gói lẻ')")
                    .bind(Uuid::new_v4()).bind(world.store_id).bind(sale).execute(world.pool()).await.unwrap();
                sqlx::query("UPDATE sales SET total=23000 WHERE id=$1")
                    .bind(sale)
                    .execute(world.pool())
                    .await
                    .unwrap();
            }
        }
        let void = Uuid::new_v4();
        sqlx::query("INSERT INTO sales (id,store_id,code,member_id,sold_at,business_date,payment_method,total,status,voided_at,request_hash) VALUES ($1,$2,$3,$4,'2026-02-10T12:00:00+07:00','2026-02-10','cash',99000,'voided',now(),'\\x00')")
            .bind(void).bind(world.store_id).bind(void.to_string()).bind(world.seller_id).execute(world.pool()).await.unwrap();
        sqlx::query("INSERT INTO sale_lines (id,store_id,sale_id,position,product_id,source,quantity,unit_price) VALUES ($1,$2,$3,0,$4,'grid',9,11000)")
            .bind(Uuid::new_v4()).bind(world.store_id).bind(void).bind(dead).execute(world.pool()).await.unwrap();
        for (product, cost, day, supplier) in [
            (active, 5000, "2026-01-01", "Kho A"),
            (active, 6000, "2026-02-09", "Kho B"),
            (dead, 9600, "2026-02-09", "Kho B"),
        ] {
            let expense = Uuid::new_v4();
            sqlx::query("INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,request_hash) VALUES ($1,$2,$3,($4::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'),$4,$5,'nhap_hang','other','\\x00')")
                .bind(expense).bind(world.store_id).bind(world.lead_id).bind(day.parse::<NaiveDate>().unwrap()).bind(i64::from(cost)).execute(world.pool()).await.unwrap();
            sqlx::query("INSERT INTO purchase_lines (store_id,expense_id,product_id,quantity,unit_cost,base_unit_cost) VALUES ($1,$2,$3,1,$4,$4)")
                .bind(world.store_id).bind(expense).bind(product).bind(i64::from(cost)).execute(world.pool()).await.unwrap();
            let image = Uuid::new_v4();
            sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose) VALUES ($1,$2,$3,'image/jpeg',10,'expense_receipt')")
                .bind(image).bind(world.store_id).bind(format!("test/{image}")).execute(world.pool()).await.unwrap();
            sqlx::query("INSERT INTO receipts (id,store_id,member_id,image_id,status,ocr_text,parser,expense_id,confirmed_at,request_hash,supplier) VALUES ($1,$2,$3,$4,'confirmed','','fallback',$5,($6::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'),'\\x00',$7)")
                .bind(Uuid::new_v4()).bind(world.store_id).bind(world.lead_id).bind(image).bind(expense).bind(day.parse::<NaiveDate>().unwrap()).bind(supplier).execute(world.pool()).await.unwrap();
        }
        sqlx::query("INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,note,request_hash) VALUES ($1,$2,$3,'2026-02-09T18:00:00Z','2026-02-10',12000,'dien','cash_box','Tiền điện','\\x00')")
            .bind(Uuid::new_v4()).bind(world.store_id).bind(world.seller_id).execute(world.pool()).await.unwrap();
        Self {
            world,
            active,
            dead,
        }
    }
    fn ctx(&self, role: Role) -> ToolContext {
        ToolContext {
            state: self.world.state.clone(),
            actor: Actor {
                store_id: self.world.store_id,
                member_id: if role == Role::Lead {
                    self.world.lead_id
                } else {
                    self.world.seller_id
                },
                session_id: Uuid::new_v4(),
                role,
                can_enroll: role == Role::Lead,
            },
            today: today(),
            language: Language::Vi,
            thread_id: Uuid::new_v4(),
            message_id: Uuid::new_v4(),
            trace_id: None,
        }
    }
    async fn run(&self, name: &str, args: Value) -> ToolOutput {
        Registry::standard()
            .run(&self.ctx(Role::Lead), name, args)
            .await
            .unwrap()
    }
}
fn today() -> NaiveDate {
    "2026-02-10".parse().unwrap()
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn summary_matches_reports_and_previous_period_and_omits_profit_for_seller() {
    let f = Fixture::new().await;
    let out = f.run("get_sales_summary", json!({})).await;
    assert_eq!(out.data["totals"]["revenue_dong"], 23000);
    assert_eq!(out.data["totals"]["sale_count"], 1);
    assert_eq!(out.data["totals"]["void_count"], 1);
    assert_eq!(out.data["totals"]["gross_profit_dong"], 8000);
    assert_eq!(out.data["previous"]["totals"]["revenue_dong"], 20000);
    assert_eq!(out.data["change_pct"]["revenue"], 15.0);
    let report = f
        .world
        .call(
            "GET",
            "/v1/reports/summary?from=2026-02-10&to=2026-02-10",
            &f.world.lead,
            Value::Null,
        )
        .await;
    assert_eq!(report.status, 200);
    assert_eq!(
        out.data["totals"]["revenue_dong"],
        report.body["buckets"][0]["revenue"]
    );
    let seller = Registry::standard()
        .run(
            &f.ctx(Role::Seller),
            "get_sales_summary",
            json!({"group_by":"member"}),
        )
        .await
        .unwrap();
    assert!(seller.data["totals"].get("gross_profit_dong").is_none());
    assert!(
        seller.data["previous"]["totals"]
            .get("gross_profit_dong")
            .is_none()
    );
    assert!(seller.data["groups"][0].get("gross_profit_dong").is_none());
    let week = f
        .run(
            "get_sales_summary",
            json!({"from":"2026-02-04","to":"2026-02-10","group_by":"week"}),
        )
        .await;
    assert_eq!(week.data["totals"]["revenue_dong"], 143000);
    assert_eq!(week.data["groups"].as_array().unwrap().len(), 2);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn top_search_and_expenses_use_base_units_and_include_manual_lines() {
    let f = Fixture::new().await;
    let top = f.run("get_top_products", json!({"metric":"units"})).await;
    assert_eq!(top.data["items"][0]["units"], 2);
    assert_eq!(top.data["items"][0]["revenue_dong"], 20000);
    assert!(Contract::load().schema_accepts("AssistantCard", top.card.as_ref().unwrap()));
    let sales = f.run("search_sales", json!({"member":"Lead"})).await;
    assert_eq!(sales.data["sale_count"], 1);
    assert_eq!(sales.rows, 2);
    assert!(
        sales.data["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "hàng ngoài danh mục" && r["revenue_dong"] == 3000)
    );
    let filtered = f
        .run(
            "search_sales",
            json!({"product_query":"hao hao","member":f.world.lead_id}),
        )
        .await;
    assert_eq!(filtered.rows, 1);
    let products = f
        .run("search_products", json!({"query":"mi hao hao"}))
        .await;
    assert_eq!(
        products.data["items"][0]["product_id"],
        f.active.to_string()
    );
    assert_eq!(products.data["items"][0]["price_dong"], 10000);
    let expenses = f.run("list_expenses", json!({"category":"dien"})).await;
    assert_eq!(expenses.data["totals_by_category_dong"]["dien"], 12000);
    assert_eq!(expenses.data["items"][0]["date"], "2026-02-10");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn restock_margin_dead_stock_and_permissions_are_exact() {
    let f = Fixture::new().await;
    let stock = f.run("get_stock_levels", json!({"filter":"low"})).await;
    assert_eq!(stock.rows, 1);
    assert_eq!(stock.data["items"][0]["status"], "low");
    let plan = f.run("get_restock_plan", json!({})).await;
    assert_eq!(plan.rows, 1);
    let item = &plan.data["items"][0];
    assert_eq!(item["avg_daily_units"], 2.0);
    assert_eq!(item["suggested_quantity"], 16);
    assert_eq!(item["unit_cost_dong"], 6000);
    assert_eq!(plan.data["grand_total_dong"], 96000);
    assert!(Contract::load().schema_accepts("AssistantCard", plan.card.as_ref().unwrap()));
    let margin = f.run("get_margin_report", json!({})).await;
    assert_eq!(margin.rows, 1);
    assert_eq!(margin.data["items"][0]["margin_pct"], 4.0);
    assert_eq!(margin.data["items"][0]["suggested_price_dong"], 11000);
    let dead = f.run("get_dead_stock", json!({})).await;
    assert_eq!(dead.rows, 1);
    assert_eq!(dead.data["items"][0]["product_id"], f.dead.to_string());
    assert_eq!(dead.data["items"][0]["tied_up_dong"], 67200);
    let seller = f.ctx(Role::Seller);
    let plan = Registry::standard()
        .run(&seller, "get_restock_plan", json!({}))
        .await
        .unwrap();
    assert!(plan.data["items"][0].get("unit_cost_dong").is_none());
    assert!(plan.data.get("grand_total_dong").is_none());
    assert!(plan.card.as_ref().unwrap()["items"][0]["unit_cost"].is_null());
    assert!(Contract::load().schema_accepts("AssistantCard", plan.card.as_ref().unwrap()));
    let dead = Registry::standard()
        .run(&seller, "get_dead_stock", json!({}))
        .await
        .unwrap();
    assert!(dead.data["items"][0].get("tied_up_dong").is_none());
    for name in ["get_margin_report", "get_supplier_prices"] {
        assert_eq!(
            Registry::standard()
                .run(&seller, name, json!({}))
                .await
                .unwrap_err(),
            ToolError::Denied
        );
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn forecast_constant_series_applies_named_holiday_uplift_and_cost_history_is_ordered() {
    let f = Fixture::new().await;
    let forecast = f
        .run(
            "forecast_demand",
            json!({"days":7,"product_query":"hao hao"}),
        )
        .await;
    assert_eq!(forecast.rows, 1);
    let item = &forecast.data["items"][0];
    assert_eq!(item["trend"], 1.0);
    assert_eq!(item["days"][0]["date"], "2026-02-11");
    assert_eq!(item["days"][0]["expected_units"], 4.0);
    assert_eq!(item["days"][0]["uplift"], 2.0);
    assert_eq!(item["days"][0]["holiday"], "Tết Nguyên Đán");
    assert_eq!(item["days"][6]["expected_units"], 1.0);
    let prices = f
        .run("get_supplier_prices", json!({"product_query":"hao hao"}))
        .await;
    assert_eq!(prices.rows, 2);
    assert_eq!(prices.data["items"][0]["unit_cost_dong"], 6000);
    assert_eq!(prices.data["cheapest"][0]["unit_cost_dong"], 5000);
    assert_eq!(prices.data["cheapest"][0]["supplier"], "Kho A");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn row_cap_and_validation_and_store_isolation() {
    let f = Fixture::new().await;
    for i in 0..52 {
        f.world.product(&format!("Nước {i:02}"), 1000, None).await;
    }
    let out = f
        .run("search_products", json!({"query":"nuoc","limit":50}))
        .await;
    assert_eq!(out.rows, 50);
    assert!(out.truncated);
    let stock = f
        .run("get_stock_levels", json!({"filter":"untracked"}))
        .await;
    assert_eq!(stock.rows, 50);
    assert!(stock.truncated);
    for (name, args) in [
        (
            "get_sales_summary",
            json!({"from":"2026-02-11","to":"2026-02-10"}),
        ),
        ("get_sales_summary", json!({"group_by":"month"})),
        ("get_top_products", json!({"metric":"profit"})),
        ("get_stock_levels", json!({"filter":"bogus"})),
        ("get_restock_plan", json!({"horizon_days":31})),
        ("forecast_demand", json!({"days":0})),
        ("search_products", json!({"query":"x","extra":1})),
        ("get_margin_report", json!({"min_margin_pct":100})),
        ("list_expenses", json!({"category":"bogus"})),
    ] {
        assert!(
            matches!(
                Registry::standard()
                    .run(&f.ctx(Role::Lead), name, args)
                    .await,
                Err(ToolError::InvalidArguments(_))
            ),
            "{name}"
        );
    }
    let mut foreign = f.ctx(Role::Lead);
    foreign.actor.store_id = Uuid::new_v4();
    let out = Registry::standard()
        .run(&foreign, "get_top_products", json!({}))
        .await
        .unwrap();
    assert_eq!(out.rows, 0);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn stock_filters_default_threshold_projection_and_unknown_costs() {
    let f = Fixture::new().await;
    let projected = f.world.product("Sắp hết", 1000, None).await;
    let negative = f.world.product("Tồn âm", 1000, None).await;
    sqlx::query("UPDATE products SET stock_quantity=CASE WHEN id=$2 THEN 10 ELSE -2 END,low_stock_threshold=NULL WHERE store_id=$1 AND id=ANY($3)")
        .bind(f.world.store_id).bind(projected).bind(vec![projected,negative]).execute(f.world.pool()).await.unwrap();
    sqlx::query("UPDATE sale_lines SET product_id=$2 WHERE store_id=$1 AND product_id=$3 AND sale_id IN (SELECT id FROM sales WHERE store_id=$1 AND business_date < '2026-02-10')")
        .bind(f.world.store_id).bind(projected).bind(f.active).execute(f.world.pool()).await.unwrap();
    let out = f
        .run("get_stock_levels", json!({"filter":"negative"}))
        .await;
    assert_eq!(out.rows, 1);
    assert_eq!(out.data["items"][0]["stock_quantity"], -2);
    assert_eq!(out.data["items"][0]["threshold"], 5);
    assert_eq!(out.data["items"][0]["status"], "out");
    let plan = f.run("get_restock_plan", json!({})).await;
    assert_eq!(plan.rows, 3);
    let items = plan.data["items"].as_array().unwrap();
    let projected = items
        .iter()
        .find(|r| r["product_id"] == projected.to_string())
        .unwrap();
    assert_eq!(projected["suggested_quantity"], 8);
    assert!(projected["unit_cost_dong"].is_null());
    assert!(
        plan.data["grand_total_dong"].is_null(),
        "a missing cost must not silently become zero"
    );
    assert!(Contract::load().schema_accepts("AssistantCard", plan.card.as_ref().unwrap()));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn all_tool_argument_schemas_are_strict_and_outputs_respect_pinned_date() {
    let f = Fixture::new().await;
    let registry = Registry::standard();
    for name in [
        "get_sales_summary",
        "get_top_products",
        "search_sales",
        "search_products",
        "get_stock_levels",
        "get_restock_plan",
        "get_margin_report",
        "get_dead_stock",
        "forecast_demand",
        "get_supplier_prices",
        "list_expenses",
    ] {
        let tool = registry.get(name).unwrap();
        assert_eq!(tool.parameters()["additionalProperties"], false, "{name}");
        assert!(
            tool.parameters()["properties"]
                .as_object()
                .unwrap()
                .values()
                .all(|p| p["description"].is_string()),
            "{name}"
        );
        assert!(
            matches!(
                registry
                    .run(&f.ctx(Role::Lead), name, json!({"unexpected":true}))
                    .await,
                Err(ToolError::InvalidArguments(_))
            ),
            "{name}"
        );
    }
    let mut old = f.ctx(Role::Lead);
    old.today = "2025-12-01".parse().unwrap();
    let out = registry
        .run(&old, "get_sales_summary", json!({}))
        .await
        .unwrap();
    assert_eq!(out.data["totals"]["revenue_dong"], 0);
    assert!(out.data["change_pct"]["revenue"].is_null());
    let out = registry
        .run(
            &old,
            "get_supplier_prices",
            json!({"product_query":"hao hao"}),
        )
        .await
        .unwrap();
    assert_eq!(
        out.rows, 0,
        "future receipts must not affect pinned evaluations"
    );
}

#[test]
fn registry_contains_every_sales_and_stock_read_tool() {
    let registry = Registry::standard();
    for name in [
        "get_sales_summary",
        "get_top_products",
        "search_sales",
        "search_products",
        "get_stock_levels",
        "get_restock_plan",
        "get_margin_report",
        "get_dead_stock",
        "forecast_demand",
        "get_supplier_prices",
        "list_expenses",
    ] {
        assert!(registry.get(name).is_some(), "missing tool {name}");
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn forecast_trend_is_clamped_and_zero_sale_weekdays_stay_in_denominator() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE sale_lines l SET quantity=4 FROM sales s WHERE s.id=l.sale_id AND s.store_id=l.store_id AND l.store_id=$1 AND l.product_id=$2 AND s.business_date BETWEEN '2026-01-28' AND '2026-02-10'")
        .bind(f.world.store_id).bind(f.active).execute(f.world.pool()).await.unwrap();
    let out = f
        .run(
            "forecast_demand",
            json!({"days":1,"product_query":"hao hao"}),
        )
        .await;
    assert_eq!(out.data["items"][0]["trend"], 2.0);
    assert_eq!(out.data["items"][0]["days"][0]["expected_units"], 14.0);
    sqlx::query("DELETE FROM sale_lines l USING sales s WHERE s.id=l.sale_id AND s.store_id=l.store_id AND l.store_id=$1 AND l.product_id=$2 AND s.business_date BETWEEN '2026-01-28' AND '2026-02-10'")
        .bind(f.world.store_id).bind(f.active).execute(f.world.pool()).await.unwrap();
    let out = f
        .run(
            "forecast_demand",
            json!({"days":1,"product_query":"hao hao"}),
        )
        .await;
    assert_eq!(out.data["items"][0]["trend"], 0.5);
    assert_eq!(out.data["items"][0]["days"][0]["expected_units"], 1.5);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn purchase_history_uses_base_cost_and_90_day_window_and_discloses_missing_suppliers() {
    let f = Fixture::new().await;
    for (day, base_cost, pack_cost, deleted) in [
        ("2025-01-01", 100_i64, 100_i64, false),
        ("2026-02-08", 4500, 27000, false),
        ("2026-02-11", 200, 200, false),
        ("2026-02-10", 300, 300, true),
    ] {
        let expense = Uuid::new_v4();
        sqlx::query("INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,request_hash,deleted_at) VALUES ($1,$2,$3,($4::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'),$4,$5,'nhap_hang','other','\\x00',CASE WHEN $6 THEN now() ELSE NULL END)")
            .bind(expense).bind(f.world.store_id).bind(f.world.lead_id).bind(day.parse::<NaiveDate>().unwrap()).bind(pack_cost).bind(deleted).execute(f.world.pool()).await.unwrap();
        sqlx::query("INSERT INTO purchase_lines (store_id,expense_id,product_id,quantity,unit_cost,base_unit_cost) VALUES ($1,$2,$3,1,$4,$5)")
            .bind(f.world.store_id).bind(expense).bind(f.active).bind(pack_cost).bind(base_cost).execute(f.world.pool()).await.unwrap();
    }
    let prices = f
        .run("get_supplier_prices", json!({"product_query":"hao hao"}))
        .await;
    assert_eq!(prices.rows, 4);
    assert_eq!(prices.data["cheapest"][0]["unit_cost_dong"], 4500);
    assert_eq!(
        prices.data["cheapest"][0]["supplier"],
        "Không rõ nhà cung cấp"
    );
    assert_eq!(prices.data["supplier_names_missing"], true);
    assert!(prices.summary_vi.contains("thiếu tên nhà cung cấp"));
    let plan = f.run("get_restock_plan", json!({})).await;
    assert_eq!(plan.data["items"][0]["unit_cost_dong"], 6000);
    assert_eq!(plan.data["items"][0]["supplier"], "Kho B");
    let summary = f
        .run(
            "get_sales_summary",
            json!({"from":"2025-12-17","to":"2026-02-10"}),
        )
        .await;
    assert_eq!(summary.rows, 50);
    assert!(summary.truncated);
    assert_eq!(summary.data["totals"]["revenue_dong"], 1123000);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn margin_report_rounds_like_app_and_excludes_zero_price_zero_cost() {
    let f = Fixture::new().await;
    for (name, price, cost) in [("Biên lẻ", 9000_i64, 8500_i64), ("Miễn phí", 0, 0)] {
        let product = f.world.product(name, price, Some(cost)).await;
        let expense = Uuid::new_v4();
        sqlx::query("INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,request_hash) VALUES ($1,$2,$3,'2026-02-10T12:00:00+07:00','2026-02-10',$4,'nhap_hang','other','\\x00')")
            .bind(expense).bind(f.world.store_id).bind(f.world.lead_id).bind(cost).execute(f.world.pool()).await.unwrap();
        sqlx::query("INSERT INTO purchase_lines (store_id,expense_id,product_id,quantity,unit_cost,base_unit_cost) VALUES ($1,$2,$3,1,$4,$4)")
            .bind(f.world.store_id).bind(expense).bind(product).bind(cost).execute(f.world.pool()).await.unwrap();
    }
    let out = f.run("get_margin_report", json!({})).await;
    assert_eq!(out.rows, 2);
    let fractional = out.data["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Biên lẻ")
        .unwrap();
    assert_eq!(fractional["margin_pct"], 5.56);
    assert_eq!(fractional["suggested_price_dong"], 9500);
}
