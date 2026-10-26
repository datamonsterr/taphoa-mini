//! SQL-only next-step chips. Each rule file registers one function in `rules()`.
mod day_close;
mod draft_receipts;
mod margin_alert;
mod restock;
mod review_queue;
mod setup;

use crate::{
    ApiError, ApiResult, AppState,
    auth::{self, Action, Actor, data::pool},
};
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
};
use chrono::{NaiveDate, NaiveDateTime, Utc};
use futures_util::future::{BoxFuture, try_join_all};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;

pub struct RuleInput {
    pub today: NaiveDate,
    pub now_local: NaiveDateTime,
    pub screen: String,
}
pub type RuleFuture<'a> = BoxFuture<'a, ApiResult<Vec<NextStep>>>;
pub type Rule = for<'a> fn(&'a PgPool, &'a Actor, &'a RuleInput) -> RuleFuture<'a>;

pub fn rules() -> Vec<Rule> {
    vec![
        restock::run,
        draft_receipts::run,
        day_close::run,
        review_queue::run,
        setup::run,
        margin_alert::run,
    ]
}

#[derive(Clone, Debug, Serialize)]
pub struct NextStep {
    pub id: String,
    pub kind: String,
    pub title_vi: String,
    pub subtitle_vi: Option<String>,
    pub priority: i32,
    pub action: Value,
    #[serde(skip)]
    pub requires: Option<Action>,
}
impl NextStep {
    fn new(
        kind: &str,
        title: &str,
        priority: i32,
        requires: Option<Action>,
        action: Value,
    ) -> Self {
        Self {
            id: kind.into(),
            kind: kind.into(),
            title_vi: title.into(),
            subtitle_vi: None,
            priority,
            action,
            requires,
        }
    }
    fn counted(mut self, count: i64, label: &str) -> Self {
        self.subtitle_vi = Some(format!("{count} {label}"));
        self
    }
}
fn chat(input: &RuleInput, kind: &str, prompt: &str) -> Value {
    json!({"type":"chat", "prompt_vi":prompt, "context":{"screen":input.screen,"next_step_id":kind}})
}
fn navigate(route: &str) -> Value {
    json!({"type":"navigate","route":route})
}

/// Shared with future rules so every new chip is permission-filtered before the cap.
pub fn rank(mut items: Vec<NextStep>, actor: &Actor) -> Vec<NextStep> {
    items.retain(|step| step.requires.is_none_or(|action| auth::can(actor, action)));
    items.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
    items.truncate(8);
    items
}

#[derive(Deserialize)]
pub struct Params {
    screen: String,
    #[serde(default)]
    document_detected: bool,
    #[serde(default)]
    unknown_product: bool,
}
#[tracing::instrument(name = "assistant.next_steps", skip_all, fields(
    otel.name = "assistant.next_steps", taphoa.next_steps.count = tracing::field::Empty,
    taphoa.next_steps.kinds = tracing::field::Empty
))]
pub async fn list(
    State(state): State<AppState>,
    actor: Actor,
    query: Result<Query<Params>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let Query(params) =
        query.map_err(|_| ApiError::validation_failed("invalid next-steps query"))?;
    if params.screen.trim().is_empty() {
        return Err(ApiError::validation_failed("screen is required"));
    }
    let now = Utc::now()
        .with_timezone(&crate::time::STORE_TZ)
        .naive_local();
    let input = RuleInput {
        today: now.date(),
        now_local: now,
        screen: params.screen,
    };
    let db = pool(&state)?;
    let mut items: Vec<_> = try_join_all(rules().iter().map(|rule| rule(db, &actor, &input)))
        .await?
        .into_iter()
        .flatten()
        .collect();
    if params.document_detected {
        items.push(NextStep::new("receipt_detected", "Nhập hóa đơn", 0, Some(Action::EnrollProduct),
            json!({"type":"chat","prompt_vi":"Nhập hàng từ hóa đơn này","context":{"screen":input.screen}})));
    }
    if params.unknown_product {
        items.push(NextStep::new(
            "unknown_product",
            "Thêm sản phẩm mới",
            1,
            Some(Action::EnrollProduct),
            navigate("/enroll"),
        ));
    }
    let items = rank(items, &actor);
    let kinds = items
        .iter()
        .map(|step| step.kind.as_str())
        .collect::<Vec<_>>()
        .join(",");
    tracing::Span::current().record("taphoa.next_steps.count", items.len());
    tracing::Span::current().record("taphoa.next_steps.kinds", kinds.as_str());
    Ok(Json(json!({"items":items})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Role;
    #[test]
    fn rank_filters_before_capping_eight() {
        let actor = Actor {
            member_id: uuid::Uuid::nil(),
            store_id: uuid::Uuid::nil(),
            clerk_user_id: "user_test".into(),
            clerk_session_id: "sess_test".into(),
            role: Role::Seller,
            can_enroll: false,
        };
        let mut items = vec![NextStep::new(
            "hidden",
            "Ẩn",
            0,
            Some(Action::ManageStore),
            navigate("/close"),
        )];
        items.extend(
            (1..=12)
                .rev()
                .map(|n| NextStep::new(&n.to_string(), "Việc", n, None, navigate("/stock"))),
        );
        let items = rank(items, &actor);
        assert_eq!(items.len(), 8);
        assert_eq!(
            items.iter().map(|v| v.priority).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );
    }
}
