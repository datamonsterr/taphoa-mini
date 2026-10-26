use super::{StoredDigest, stored, template};
use crate::{
    AppState,
    assistant::{
        Language,
        config::ModelProvider,
        model::{ChatMessage, ChatRequest},
        quota,
        tools::ToolContext,
    },
    auth::{Actor, Role, data::pool},
};
use chrono::{Duration, NaiveDate};
use serde_json::{Value, json};
use uuid::Uuid;

pub async fn generate(
    state: &AppState,
    store_id: Uuid,
    business_date: NaiveDate,
) -> anyhow::Result<StoredDigest> {
    crate::telemetry::job(
        "digest.generate",
        1,
        generate_inner(state, store_id, business_date),
    )
    .await
}

async fn generate_inner(
    state: &AppState,
    store_id: Uuid,
    business_date: NaiveDate,
) -> anyhow::Result<StoredDigest> {
    let db = pool(state).map_err(|_| anyhow::anyhow!("database unavailable"))?;
    if let Some(digest) = stored(db, store_id, business_date).await? {
        return Ok(digest);
    }
    let member_id = sqlx::query_scalar("SELECT id FROM members WHERE store_id=$1 AND active AND role='lead' ORDER BY created_at,id LIMIT 1")
        .bind(store_id).fetch_one(db).await?;
    let ctx = ToolContext {
        state: state.clone(),
        actor: Actor {
            store_id,
            member_id,
            session_id: Uuid::nil(),
            role: Role::Lead,
            can_enroll: true,
        },
        today: business_date,
        language: Language::Vi,
        thread_id: Uuid::nil(),
        message_id: Uuid::nil(),
        trace_id: None,
    };
    let yesterday = business_date
        .checked_sub_signed(Duration::days(1))
        .ok_or_else(|| anyhow::anyhow!("digest business date out of range"))?;
    let sales = state
        .assistant
        .registry
        .run(
            &ctx,
            "get_sales_summary",
            json!({"from":yesterday,"to":yesterday,"group_by":"day"}),
        )
        .await?
        .data;
    let restock = state
        .assistant
        .registry
        .run(&ctx, "get_restock_plan", json!({"horizon_days":7}))
        .await?
        .data;
    let items:Vec<Value> = restock["items"].as_array().into_iter().flatten().take(10).map(|i|json!({
        "product_id":i["product_id"],"name":i["name"],"quantity":i["suggested_quantity"],"unit_cost":i["unit_cost_dong"],"total_cost":i["line_total_dong"]
    })).collect();
    let (count,total):(i64,i64) = sqlx::query_as("SELECT count(*),coalesce(sum(balance),0)::bigint FROM customers WHERE store_id=$1 AND balance>0 AND oldest_debt_date < $2::date - 7")
        .bind(store_id).bind(business_date).fetch_one(db).await?;
    let drafts:i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM receipts WHERE store_id=$1 AND status='draft') + (SELECT count(*) FROM assistant_actions WHERE store_id=$1 AND status='proposed' AND expires_at > now())")
        .bind(store_id).fetch_one(db).await?;
    let change = sales["change_pct"]["revenue"]
        .as_f64()
        .map(|n| (n * 10.0).round() / 10.0);
    let payload = json!({"sales":{"revenue":sales["totals"]["revenue_dong"],"sale_count":sales["totals"]["sale_count"],"gross_profit":sales["totals"]["gross_profit_dong"],"change_pct":change},
        "restock":items,"overdue_debts":{"count":count,"total":total},"open_drafts":{"count":drafts}});
    let (source, model, summary) = match model_summary(state, &payload).await? {
        Some((model, summary)) => ("model", Some(model), summary),
        None => ("template", None, template::render(&payload)),
    };
    sqlx::query("INSERT INTO assistant_digests(store_id,business_date,source,model,summary_vi,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(store_id,business_date) DO NOTHING")
        .bind(store_id).bind(business_date).bind(source).bind(model).bind(summary).bind(payload).execute(db).await?;
    stored(db, store_id, business_date)
        .await?
        .ok_or_else(|| anyhow::anyhow!("digest missing after insert"))
}

async fn model_summary(
    state: &AppState,
    payload: &Value,
) -> anyhow::Result<Option<(String, String)>> {
    let config = &state.assistant.config;
    let Some(model) = &state.assistant.model else {
        return Ok(None);
    };
    if config.model_provider == ModelProvider::Scripted
        || config.digest_model_max_per_day == 0
        || quota::openrouter_exhausted(state).await
    {
        return Ok(None);
    }
    let db = pool(state).map_err(|_| anyhow::anyhow!("database unavailable"))?;
    let written: i64 = sqlx::query_scalar("SELECT count(*) FROM assistant_digests WHERE source='model' AND generated_at >= date_trunc('day',now())")
        .fetch_one(db).await?;
    if written >= i64::from(config.digest_model_max_per_day) {
        return Ok(None);
    }
    for name in &config.models {
        let request = ChatRequest {
            model: name.clone(),
            messages: vec![
                ChatMessage::system(include_str!("prompt.vi.md")),
                ChatMessage::user(payload.to_string()),
            ],
            tools: vec![],
            tool_choice: None,
            max_tokens: 400,
            reasoning_effort: Some(config.reasoning_effort.clone()),
        };
        let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();
        match model.chat(&request, &sender).await {
            Ok(response) => {
                let content = response.content.trim();
                return Ok(
                    safe_summary(content, payload).then(|| (response.model, content.to_owned()))
                );
            }
            Err(error) if error.retryable() => continue,
            Err(_) => break,
        }
    }
    Ok(None)
}

fn safe_summary(text: &str, payload: &Value) -> bool {
    fn leaks(text: &str, value: &Value) -> bool {
        match value {
            Value::Object(fields) => fields.iter().any(|(key, value)| {
                if matches!(key.as_str(), "gross_profit" | "unit_cost" | "total_cost") {
                    value.as_i64().is_some_and(|amount| {
                        let digits = amount.unsigned_abs().to_string();
                        let grouped = crate::assistant::tools::vnd(amount);
                        let grouped = grouped.trim_start_matches('-').trim_end_matches(" ₫");
                        text.contains(&digits) || text.contains(grouped)
                    })
                } else {
                    leaks(text, value)
                }
            }),
            Value::Array(items) => items.iter().any(|value| leaks(text, value)),
            _ => false,
        }
    }
    text.trim().chars().count() >= 20
        && !text.contains('*')
        && !text.contains('#')
        && !leaks(text, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_rejects_empty_short_markdown_and_every_cost_or_profit_format() {
        let data = json!({"sales":{"gross_profit":-22018},"restock":[{"unit_cost":6291,"total_cost":37746},{"unit_cost":null,"total_cost":null}]});
        assert!(safe_summary(
            "Hôm qua cửa hàng có doanh thu và cần nhập thêm hàng.",
            &data
        ));
        for text in [
            "",
            "   ",
            "Xin chào",
            "# Hôm qua cửa hàng có doanh thu",
            "Hôm qua * cửa hàng có doanh thu",
            "Hôm qua lợi nhuận -22018 đồng.",
            "Hôm qua lợi nhuận -22.018 đồng.",
            "Giá nhập hàng hôm qua là 6291 đồng.",
            "Giá nhập hàng hôm qua là 6.291 đồng.",
            "Tổng giá nhập hàng là 37746 đồng.",
            "Tổng giá nhập hàng là 37.746 đồng.",
        ] {
            assert!(!safe_summary(text, &data), "{text}");
        }
    }
}
