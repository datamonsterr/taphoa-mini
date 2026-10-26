//! Daily digest HTTP and scheduler seams, with real database tools and no external model calls.
mod common;

use axum::http::StatusCode;
use common::{Contract, world::World};
use serde_json::Value;

const PATH: &str = "/v1/assistant/digest";

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn today_is_cached_and_read_state_is_per_member() {
    let w = World::new().await;
    let first = w.call("GET", PATH, &w.lead, Value::Null).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    Contract::load().assert_conforms(PATH, "get", StatusCode::OK, &first.body);
    assert_eq!(first.body["source"], "template");
    assert!(first.body["sales"]["change_pct"].is_null());
    assert!(first.body["read_at"].is_null());
    let today = taphoa_api::time::business_date(chrono::Utc::now());
    let second = w
        .call(
            "GET",
            &format!("{PATH}?business_date={today}"),
            &w.lead,
            Value::Null,
        )
        .await;
    assert_eq!(second.status, StatusCode::OK);
    assert_eq!(first.body["generated_at"], second.body["generated_at"]);
    assert!(second.body["read_at"].is_string());
    let seller = w.call("GET", PATH, &w.seller, Value::Null).await;
    assert!(seller.body["read_at"].is_null());
    assert!(seller.body["sales"]["gross_profit"].is_null());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn historical_missing_and_invalid_dates_are_errors() {
    let w = World::new().await;
    for (date, expected) in [
        ("2020-01-01", StatusCode::NOT_FOUND),
        ("nope", StatusCode::BAD_REQUEST),
    ] {
        let r = w
            .call(
                "GET",
                &format!("{PATH}?business_date={date}"),
                &w.lead,
                Value::Null,
            )
            .await;
        assert_eq!(r.status, expected, "{}", r.body);
    }
}

async fn fixture() -> World {
    use chrono::{Duration, Utc};
    use uuid::Uuid;
    let w = World::new().await;
    let today = taphoa_api::time::business_date(Utc::now());
    let product = w.product("Sữa", 17300, Some(6291)).await;
    sqlx::query("UPDATE products SET stock_quantity=1,low_stock_threshold=5 WHERE id=$1")
        .bind(product)
        .execute(w.pool())
        .await
        .unwrap();
    for (offset, total) in [(1, 34600_i64), (2, 30000), (0, 999999)] {
        let sale = Uuid::new_v4();
        sqlx::query("INSERT INTO sales(id,store_id,code,member_id,sold_at,business_date,payment_method,total,request_hash) VALUES($1,$2,$3,$4,now(),$5,'cash',$6,'hash')")
            .bind(sale).bind(w.store_id).bind(sale.to_string()).bind(w.lead_id).bind(today-Duration::days(offset)).bind(total).execute(w.pool()).await.unwrap();
        sqlx::query("INSERT INTO sale_lines(id,store_id,sale_id,position,product_id,source,quantity,unit_price) VALUES($1,$2,$3,0,$4,'grid',2,$5)")
            .bind(Uuid::new_v4()).bind(w.store_id).bind(sale).bind(product).bind(total/2).execute(w.pool()).await.unwrap();
    }
    let expense = Uuid::new_v4();
    sqlx::query("INSERT INTO expenses(id,store_id,member_id,spent_at,business_date,amount,category,paid_with,request_hash) VALUES($1,$2,$3,now(),$4,6291,'nhap_hang','other','hash')").bind(expense).bind(w.store_id).bind(w.lead_id).bind(today).execute(w.pool()).await.unwrap();
    sqlx::query("INSERT INTO purchase_lines(store_id,expense_id,product_id,quantity,unit_cost,base_unit_cost) VALUES($1,$2,$3,1,6291,6291)").bind(w.store_id).bind(expense).bind(product).execute(w.pool()).await.unwrap();
    w
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn yesterday_comparison_and_costs_are_masked_for_seller() {
    let w = fixture().await;
    let lead = w
        .checked("GET", PATH, PATH, &w.lead, Value::Null, StatusCode::OK)
        .await;
    assert_eq!(lead["sales"]["revenue"], 34600);
    assert_eq!(lead["sales"]["sale_count"], 1);
    assert_eq!(lead["sales"]["gross_profit"], 22018);
    assert_eq!(lead["sales"]["change_pct"], 15.3);
    assert_eq!(lead["restock"].as_array().unwrap().len(), 1);
    assert_eq!(lead["restock"][0]["unit_cost"], 6291);
    assert!(lead["restock"][0]["total_cost"].is_number());
    let seller = w
        .checked("GET", PATH, PATH, &w.seller, Value::Null, StatusCode::OK)
        .await;
    assert!(seller["sales"]["gross_profit"].is_null());
    for item in seller["restock"].as_array().unwrap() {
        assert!(item["unit_cost"].is_null());
        assert!(item["total_cost"].is_null());
    }
    assert_eq!(lead["summary_vi"], seller["summary_vi"]);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn scheduler_generation_adds_unread_chip_and_member_read_removes_only_their_chip() {
    use chrono::Utc;
    use taphoa_api::assistant::digest;
    let w = World::new().await;
    async fn chips(w: &World, token: &str) -> Vec<Value> {
        let r = w
            .call(
                "GET",
                "/v1/assistant/next-steps?screen=home",
                token,
                Value::Null,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["kind"] == "digest")
            .cloned()
            .collect()
    }
    assert!(chips(&w, &w.lead).await.is_empty());
    let today = taphoa_api::time::business_date(Utc::now());
    let stored = digest::generate(&w.state, w.store_id, today).await.unwrap();
    let chip = chips(&w, &w.lead).await;
    assert_eq!(chip.len(), 1);
    assert_eq!(chip[0]["id"], format!("digest:{today}"));
    assert_eq!(chip[0]["title_vi"], "Tóm tắt sáng nay");
    assert_eq!(chip[0]["priority"], 5);
    assert_eq!(
        chip[0]["action"],
        serde_json::json!({"type":"navigate","route":"/digest"})
    );
    let read = w.call("GET", PATH, &w.lead, Value::Null).await;
    assert_eq!(
        read.body["generated_at"],
        serde_json::json!(stored.generated_at)
    );
    assert!(chips(&w, &w.lead).await.is_empty());
    assert_eq!(chips(&w, &w.seller).await.len(), 1);
    let regenerated = digest::generate(&w.state, w.store_id, today).await.unwrap();
    assert_eq!(stored.generated_at, regenerated.generated_at);
}

#[derive(Clone)]
struct FixedModel {
    answer: Result<String, taphoa_api::assistant::model::ModelError>,
    calls: std::sync::Arc<std::sync::Mutex<Vec<taphoa_api::assistant::model::ChatRequest>>>,
}
#[async_trait::async_trait]
impl taphoa_api::assistant::model::ChatModel for FixedModel {
    async fn chat(
        &self,
        request: &taphoa_api::assistant::model::ChatRequest,
        _: &tokio::sync::mpsc::UnboundedSender<String>,
    ) -> Result<taphoa_api::assistant::model::ChatResponse, taphoa_api::assistant::model::ModelError>
    {
        use taphoa_api::assistant::model::{ChatResponse, Usage};
        assert!(request.tools.is_empty());
        assert!(request.tool_choice.is_none());
        assert_eq!(request.max_tokens, 400);
        assert_eq!(request.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(request.messages.len(), 2);
        let data: Value =
            serde_json::from_str(request.messages[1].content.as_ref().unwrap()).unwrap();
        assert!(data["sales"]["revenue"].is_number());
        self.calls.lock().unwrap().push(request.clone());
        Ok(ChatResponse {
            model: request.model.clone(),
            content: self.answer.clone()?,
            tool_calls: vec![],
            finish_reason: "stop".into(),
            usage: Usage::default(),
            http_status: 200,
            time_to_first_token: None,
        })
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn model_success_rejection_fallback_order_and_budget_guards() {
    use std::sync::{Arc, Mutex};
    use taphoa_api::assistant::{config::ModelProvider, model::ModelError, quota};
    // One test keeps the process-local quota flag isolated from other model scenarios.
    for scenario in [
        "success",
        "profit",
        "grouped-profit",
        "unit-cost",
        "empty",
        "short",
        "markdown",
        "unavailable",
        "nonretryable",
        "zero-cap",
        "daily-cap",
        "quota",
        "scripted",
    ] {
        let mut w = fixture().await;
        w.state.redis = None;
        quota::clear_openrouter_exhausted(&w.state).await;
        let mut config = (*w.state.assistant.config).clone();
        config.models = vec!["first:free".into(), "second:free".into()];
        config.digest_model_max_per_day = u32::MAX;
        let answer = match scenario {
            "profit" => Ok("Hôm qua lợi nhuận là 22018 đồng, hãy nhập thêm hàng.".into()),
            "grouped-profit" => Ok("Hôm qua lợi nhuận là 22.018 đồng, hãy nhập thêm hàng.".into()),
            "unit-cost" => Ok("Hôm qua giá vốn là 6.291 đồng, hãy nhập thêm hàng.".into()),
            "empty" => Ok("  ".into()),
            "short" => Ok("Xin chào".into()),
            "markdown" => Ok("# Hôm qua cửa hàng bán tốt và cần nhập thêm hàng.".into()),
            "unavailable" => Err(ModelError::Unavailable {
                status: 503,
                message: "offline".into(),
            }),
            "nonretryable" => Err(ModelError::Other {
                status: Some(400),
                message: "stop".into(),
            }),
            _ => Ok(
                "Hôm qua cửa hàng có doanh thu. Hãy xem hàng cần nhập và các việc đang chờ xử lý."
                    .into(),
            ),
        };
        if scenario == "zero-cap" {
            config.digest_model_max_per_day = 0;
        }
        if scenario == "daily-cap" {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM assistant_digests WHERE source='model' AND business_date=$1",
            )
            .bind(taphoa_api::time::business_date(chrono::Utc::now()))
            .fetch_one(w.pool())
            .await
            .unwrap();
            assert!(count > 0);
            config.digest_model_max_per_day = count.try_into().unwrap();
        }
        if scenario == "scripted" {
            config.model_provider = ModelProvider::Scripted;
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        w.state.assistant.model = Some(Arc::new(FixedModel {
            answer,
            calls: calls.clone(),
        }));
        w.state.assistant.config = Arc::new(config);
        if scenario == "quota" {
            quota::mark_openrouter_exhausted(&w.state).await;
        }
        w.app = taphoa_api::router(w.state.clone());
        let r = w
            .checked("GET", PATH, PATH, &w.lead, Value::Null, StatusCode::OK)
            .await;
        assert_eq!(
            r["source"],
            if scenario == "success" {
                "model"
            } else {
                "template"
            },
            "{scenario}: {r}"
        );
        let stored = taphoa_api::assistant::digest::get_or_generate(
            &w.state,
            w.store_id,
            taphoa_api::time::business_date(chrono::Utc::now()),
        )
        .await
        .unwrap();
        if scenario == "success" {
            assert_eq!(stored.model.as_deref(), Some("first:free"));
        } else {
            assert!(stored.model.is_none());
        }
        let expected = match scenario {
            "unavailable" => vec!["first:free", "second:free"],
            "zero-cap" | "daily-cap" | "quota" | "scripted" => vec![],
            _ => vec!["first:free"],
        };
        {
            let requests = calls.lock().unwrap();
            let models: Vec<_> = requests.iter().map(|r| r.model.as_str()).collect();
            assert_eq!(models, expected, "{scenario}");
            for request in requests.iter() {
                let user = request.messages[1].content.as_ref().unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(user).unwrap()["sales"]["revenue"],
                    34600
                );
                for forbidden in ["gross_profit", "unit_cost", "total_cost"] {
                    assert!(
                        !user.contains(forbidden),
                        "model received {forbidden}: {user}"
                    );
                }
                let mut amounts = vec![stored.payload["sales"]["gross_profit"].as_i64().unwrap()];
                for item in stored.payload["restock"].as_array().unwrap() {
                    amounts.push(item["unit_cost"].as_i64().unwrap());
                    amounts.push(item["total_cost"].as_i64().unwrap());
                }
                for amount in amounts {
                    assert!(
                        !user.contains(&amount.to_string()),
                        "model received private amount {amount}: {user}"
                    );
                }
            }
        }
        quota::clear_openrouter_exhausted(&w.state).await;
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn concurrent_generation_keeps_one_cached_row_and_first_read_timestamp() {
    use chrono::Utc;
    use taphoa_api::assistant::digest;
    let w = fixture().await;
    let today = taphoa_api::time::business_date(Utc::now());
    let (first, second) = tokio::join!(
        digest::generate(&w.state, w.store_id, today),
        digest::generate(&w.state, w.store_id, today)
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(first.generated_at, second.generated_at);
    assert_eq!(first.payload, second.payload);
    assert!(
        digest::mark_read(w.pool(), w.store_id, today, w.lead_id)
            .await
            .is_none()
    );
    let read = digest::mark_read(w.pool(), w.store_id, today, w.lead_id)
        .await
        .unwrap();
    assert_eq!(
        digest::mark_read(w.pool(), w.store_id, today, w.lead_id).await,
        Some(read)
    );
    let ids = digest::active_store_ids(w.pool(), chrono::Duration::days(30))
        .await
        .unwrap();
    assert!(ids.contains(&w.store_id));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn historical_rows_are_read_without_generating_missing_dates_or_crossing_stores() {
    use chrono::{Duration, Utc};
    use taphoa_api::assistant::digest;
    let w = fixture().await;
    let date = taphoa_api::time::business_date(Utc::now()) - Duration::days(2);
    let stored = digest::generate(&w.state, w.store_id, date).await.unwrap();
    let r = w
        .checked(
            "GET",
            &format!("{PATH}?business_date={date}"),
            PATH,
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(r["business_date"], date.to_string());
    assert_eq!(r["generated_at"], serde_json::json!(stored.generated_at));
    let other = World::new().await;
    let r = other
        .call(
            "GET",
            &format!("{PATH}?business_date={date}"),
            &other.lead,
            Value::Null,
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn seller_can_generate_without_an_active_lead() {
    let w = fixture().await;
    sqlx::query("UPDATE members SET active=false WHERE id=$1")
        .bind(w.lead_id)
        .execute(w.pool())
        .await
        .unwrap();
    let r = w
        .checked("GET", PATH, PATH, &w.seller, Value::Null, StatusCode::OK)
        .await;
    assert_eq!(r["sales"]["revenue"], 34600);
    assert!(r["sales"]["gross_profit"].is_null());
    let stored = taphoa_api::assistant::digest::get_or_generate(
        &w.state,
        w.store_id,
        taphoa_api::time::business_date(chrono::Utc::now()),
    )
    .await
    .unwrap();
    assert_eq!(stored.payload["sales"]["gross_profit"], 22018);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn no_active_members_maps_generation_error_to_not_found() {
    use taphoa_api::{
        assistant::digest,
        auth::{Actor, Role},
    };
    let w = World::new().await;
    sqlx::query("UPDATE members SET active=false WHERE store_id=$1")
        .bind(w.store_id)
        .execute(w.pool())
        .await
        .unwrap();
    // Exercise the handler after authentication, as if membership changed in between.
    let actor = Actor {
        store_id: w.store_id,
        member_id: w.seller_id,
        session_id: uuid::Uuid::nil(),
        role: Role::Seller,
        can_enroll: false,
    };
    let params = serde_json::from_value(serde_json::json!({})).unwrap();
    let error = digest::get(
        axum::extract::State(w.state),
        actor,
        Ok(axum::extract::Query(params)),
    )
    .await
    .unwrap_err();
    use axum::response::IntoResponse;
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let bytes = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["code"],
        "not_found"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn model_cap_uses_business_date_even_for_backfills() {
    use std::sync::{Arc, Mutex};
    use taphoa_api::assistant::{digest, quota};
    let mut w = fixture().await;
    w.state.redis = None;
    quota::clear_openrouter_exhausted(&w.state).await;
    let today = taphoa_api::time::business_date(chrono::Utc::now());
    let date = today - chrono::Duration::days(1000);
    let (other, capped) = (World::new().await, World::new().await);
    // Today's generated_at must not consume a backfill business date's budget.
    sqlx::query("INSERT INTO assistant_digests(store_id,business_date,source,model,summary_vi,payload) VALUES($1,$2,'model','test','A stored summary', '{}')")
        .bind(w.store_id).bind(today).execute(w.pool()).await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM assistant_digests WHERE source='model' AND business_date=$1",
    )
    .bind(date)
    .fetch_one(w.pool())
    .await
    .unwrap();
    let mut config = (*w.state.assistant.config).clone();
    config.models = vec!["first:free".into()];
    config.digest_model_max_per_day = (count + 1).try_into().unwrap();
    w.state.assistant.config = Arc::new(config);
    let calls = Arc::new(Mutex::new(Vec::new()));
    w.state.assistant.model = Some(Arc::new(FixedModel {
        answer: Ok("Hôm qua cửa hàng có doanh thu và cần xem hàng cần nhập.".into()),
        calls: calls.clone(),
    }));
    let first = digest::generate(&w.state, other.store_id, date)
        .await
        .unwrap();
    assert_eq!(first.source, "model");
    // A row generated long ago still consumes its business date's budget.
    sqlx::query("UPDATE assistant_digests SET generated_at=now()-interval '2 days' WHERE store_id=$1 AND business_date=$2")
        .bind(other.store_id).bind(date).execute(w.pool()).await.unwrap();
    let second = digest::generate(&w.state, capped.store_id, date)
        .await
        .unwrap();
    assert_eq!(second.source, "template");
    assert_eq!(calls.lock().unwrap().len(), 1);
    for store_id in [w.store_id, other.store_id, capped.store_id] {
        sqlx::query("DELETE FROM stores WHERE id=$1")
            .bind(store_id)
            .execute(w.pool())
            .await
            .unwrap();
    }
}
