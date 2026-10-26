//! Assistant tools. A tool reads store data (`Read`) or drafts a write for the owner to confirm
//! (`Propose`); it never changes anything itself. Each batch file adds its tools to `all()`.
pub mod catalog;
pub mod debts;
pub mod help;
mod holidays;
pub mod ops;
pub mod propose;
mod queries;
pub mod sales;
pub mod stock;
pub mod tax;

use super::{Language, model::ToolSpec};
use crate::{
    ApiError, AppState,
    auth::{self, Actor},
};
use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

/// Rows a tool returns at most; more rows set `truncated`.
pub const MAX_ROWS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Read,
    Propose,
}

#[derive(Clone)]
pub struct ToolContext {
    pub state: AppState,
    pub actor: Actor,
    /// Business date; the eval header may replace it. Tools never call `now()` for it.
    pub today: NaiveDate,
    pub language: Language,
    pub thread_id: Uuid,
    pub message_id: Uuid,
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutput {
    /// JSON given to the model, as data.
    pub data: Value,
    pub summary_vi: String,
    pub rows: usize,
    pub truncated: bool,
    /// An `AssistantCard` sent to the client.
    pub card: Option<Value>,
    /// An `AssistantAction`, set by propose tools.
    pub action: Option<Value>,
}
impl ToolOutput {
    pub fn new(data: Value, summary_vi: impl Into<String>) -> Self {
        Self {
            data,
            summary_vi: summary_vi.into(),
            rows: 0,
            truncated: false,
            card: None,
            action: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ToolError {
    /// `auth::can` failed when the tool ran.
    #[error("permission denied")]
    Denied,
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("tool failed: {0}")]
    Failed(String),
}
impl From<ApiError> for ToolError {
    fn from(error: ApiError) -> Self {
        match error.status.as_u16() {
            403 => Self::Denied,
            404 => Self::NotFound(error.message),
            400 | 422 => Self::InvalidArguments(error.message),
            _ => Self::Failed(error.message),
        }
    }
}
impl From<sqlx::Error> for ToolError {
    fn from(error: sqlx::Error) -> Self {
        crate::error::log_sqlx_error!(error, &error, "assistant tool query failed");
        Self::Failed("database error".into())
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn kind(&self) -> ToolKind;
    /// Vietnamese description for the model.
    fn description_vi(&self) -> &'static str;
    /// JSON Schema of the arguments (an object schema).
    fn parameters(&self) -> Value;
    fn requires(&self) -> Option<auth::Action>;
    /// Status line shown while the tool runs, e.g. "Đang xem doanh thu…".
    fn label_vi(&self) -> &'static str;
    async fn run(&self, ctx: &ToolContext, args: Value) -> Result<ToolOutput, ToolError>;
}

#[derive(Clone)]
pub struct Registry {
    tools: Vec<Arc<dyn Tool>>,
}
impl Registry {
    pub fn new(tools: Vec<Arc<dyn Tool>>) -> Self {
        Self { tools }
    }
    pub fn standard() -> Self {
        Self::new(all())
    }
    fn allowed(tool: &dyn Tool, actor: &Actor) -> bool {
        tool.requires()
            .is_none_or(|action| auth::can(actor, action))
    }
    /// Only the tools the actor may use; this is the list sent to the model.
    pub fn for_actor(&self, actor: &Actor) -> Vec<Arc<dyn Tool>> {
        self.tools
            .iter()
            .filter(|tool| Self::allowed(tool.as_ref(), actor))
            .cloned()
            .collect()
    }
    pub fn specs_for(&self, actor: &Actor) -> Vec<ToolSpec> {
        self.for_actor(actor)
            .iter()
            .map(|tool| ToolSpec {
                name: tool.name().into(),
                description: tool.description_vi().into(),
                parameters: tool.parameters(),
            })
            .collect()
    }
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.iter().find(|tool| tool.name() == name).cloned()
    }
    /// Re-checks permission, validates that `args` is an object, then runs the tool with no
    /// timeout (the agent loop adds it).
    pub async fn run(
        &self,
        ctx: &ToolContext,
        name: &str,
        args: Value,
    ) -> Result<ToolOutput, ToolError> {
        let tool = self
            .get(name)
            .ok_or_else(|| ToolError::NotFound(format!("unknown tool {name}")))?;
        if !Self::allowed(tool.as_ref(), &ctx.actor) {
            return Err(ToolError::Denied);
        }
        if !args.is_object() {
            return Err(ToolError::InvalidArguments(
                "Tham số phải là một đối tượng JSON".into(),
            ));
        }
        tool.run(ctx, args).await
    }
}

pub fn all() -> Vec<Arc<dyn Tool>> {
    let mut tools = Vec::new();
    tools.extend(sales::all());
    tools.extend(stock::all());
    tools.extend(ops::all());
    tools.extend(catalog::all());
    tools.extend(help::all());
    tools.extend(tax::all());
    tools.extend(debts::all());
    tools.extend(propose::all());
    tools
}

/// Keeps at most `MAX_ROWS` rows. Tools fetch `MAX_ROWS + 1` so the flag is exact.
pub fn truncate<T>(mut rows: Vec<T>) -> (Vec<T>, bool) {
    let truncated = rows.len() > MAX_ROWS;
    rows.truncate(MAX_ROWS);
    (rows, truncated)
}

/// Money for `summary_vi` text: integer đồng as `1.234.000 ₫`.
pub fn vnd(amount: i64) -> String {
    let digits = amount.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            grouped.push('.');
        }
        grouped.push(digit);
    }
    let sign = if amount < 0 { "-" } else { "" };
    format!("{sign}{grouped} ₫")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{Action, Role};
    use serde_json::json;

    struct Dummy {
        name: &'static str,
        requires: Option<Action>,
    }
    #[async_trait]
    impl Tool for Dummy {
        fn name(&self) -> &'static str {
            self.name
        }
        fn kind(&self) -> ToolKind {
            ToolKind::Read
        }
        fn description_vi(&self) -> &'static str {
            "Công cụ thử"
        }
        fn parameters(&self) -> Value {
            json!({"type":"object","properties":{}})
        }
        fn requires(&self) -> Option<Action> {
            self.requires
        }
        fn label_vi(&self) -> &'static str {
            "Đang thử…"
        }
        async fn run(&self, _: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
            Ok(ToolOutput::new(args, self.name))
        }
    }
    fn registry() -> Registry {
        let tool = |name, requires| Arc::new(Dummy { name, requires }) as Arc<dyn Tool>;
        Registry::new(vec![
            tool("open", None),
            tool("price", Some(Action::ChangePrice)),
            tool("enroll", Some(Action::EnrollProduct)),
            tool("expense", Some(Action::AddExpense)),
        ])
    }
    fn actor(role: Role, can_enroll: bool) -> Actor {
        Actor {
            member_id: Uuid::new_v4(),
            store_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            role,
            can_enroll: role == Role::Lead || can_enroll,
        }
    }
    fn context(actor: Actor) -> ToolContext {
        ToolContext {
            state: AppState::default(),
            actor,
            today: NaiveDate::from_ymd_opt(2026, 10, 25).unwrap(),
            language: Language::Vi,
            thread_id: Uuid::new_v4(),
            message_id: Uuid::new_v4(),
            trace_id: None,
        }
    }
    fn names(registry: &Registry, actor: &Actor) -> Vec<&'static str> {
        registry
            .for_actor(actor)
            .iter()
            .map(|tool| tool.name())
            .collect()
    }

    #[test]
    fn seller_never_sees_lead_only_tools() {
        let registry = registry();
        assert_eq!(
            names(&registry, &actor(Role::Seller, false)),
            ["open", "expense"]
        );
        assert_eq!(
            names(&registry, &actor(Role::Lead, false)),
            ["open", "price", "enroll", "expense"]
        );
    }

    #[test]
    fn enrollment_tools_follow_can_enroll() {
        let registry = registry();
        assert_eq!(
            names(&registry, &actor(Role::Seller, true)),
            ["open", "enroll", "expense"]
        );
        let specs = registry.specs_for(&actor(Role::Seller, true));
        assert_eq!(
            specs.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["open", "enroll", "expense"]
        );
        assert_eq!(specs[0].description, "Công cụ thử");
        assert_eq!(specs[0].parameters["type"], "object");
    }

    #[tokio::test]
    async fn run_rechecks_permission_for_hidden_tools() {
        let registry = registry();
        let seller = context(actor(Role::Seller, false));
        assert_eq!(
            registry.run(&seller, "price", json!({})).await.unwrap_err(),
            ToolError::Denied
        );
        // Denial wins over argument validation: the seller learns nothing about the schema.
        assert_eq!(
            registry.run(&seller, "price", json!(7)).await.unwrap_err(),
            ToolError::Denied
        );
        let lead = context(actor(Role::Lead, false));
        let output = registry.run(&lead, "price", json!({"a":1})).await.unwrap();
        assert_eq!(output.data, json!({"a":1}));
        assert_eq!(output.summary_vi, "price");
        let output = registry.run(&seller, "expense", json!({})).await.unwrap();
        assert_eq!((output.rows, output.truncated), (0, false));
        assert!(output.card.is_none() && output.action.is_none());
    }

    #[tokio::test]
    async fn run_rejects_non_object_arguments_and_unknown_tools() {
        let registry = registry();
        let lead = context(actor(Role::Lead, false));
        for args in [json!(null), json!([]), json!("{}"), json!(1), json!(true)] {
            assert!(
                matches!(
                    registry.run(&lead, "open", args.clone()).await,
                    Err(ToolError::InvalidArguments(_))
                ),
                "{args}"
            );
        }
        assert!(registry.run(&lead, "open", json!({})).await.is_ok());
        assert!(matches!(
            registry.run(&lead, "missing", json!({})).await,
            Err(ToolError::NotFound(_))
        ));
        assert!(registry.get("open").is_some() && registry.get("missing").is_none());
    }

    #[test]
    fn standard_registry_has_unique_names_and_object_schemas() {
        let tools = all();
        let mut names: Vec<_> = tools.iter().map(|tool| tool.name()).collect();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "tool names must be unique");
        assert!(names.contains(&"get_store_overview"));
        for tool in &tools {
            assert_eq!(tool.parameters()["type"], "object", "{}", tool.name());
            assert!(!tool.description_vi().is_empty() && !tool.label_vi().is_empty());
        }
        // A lead may use every tool; a seller only those without a lead-only action.
        let standard = Registry::standard();
        assert_eq!(standard.for_actor(&actor(Role::Lead, false)).len(), total);
        assert!(
            standard
                .for_actor(&actor(Role::Seller, false))
                .iter()
                .all(|tool| tool.requires().is_none_or(|action| matches!(
                    action,
                    Action::Sell
                        | Action::VoidOwnSaleSameDay
                        | Action::AddExpense
                        | Action::RecordDebt
                )))
        );
    }

    #[test]
    fn truncate_caps_rows_and_flags_the_overflow() {
        let (rows, truncated) = truncate((0..MAX_ROWS).collect());
        assert_eq!((rows.len(), truncated), (MAX_ROWS, false));
        let (rows, truncated) = truncate((0..=MAX_ROWS).collect());
        assert_eq!((rows.len(), truncated), (MAX_ROWS, true));
        assert_eq!(rows.last(), Some(&(MAX_ROWS - 1)));
        let (rows, truncated) = truncate(Vec::<u8>::new());
        assert!(rows.is_empty() && !truncated);
    }

    #[test]
    fn vnd_groups_thousands() {
        for (amount, text) in [
            (0, "0 ₫"),
            (999, "999 ₫"),
            (1_000, "1.000 ₫"),
            (1_234_000, "1.234.000 ₫"),
            (-120_000, "-120.000 ₫"),
            (12_345_678_901, "12.345.678.901 ₫"),
            (i64::MIN, "-9.223.372.036.854.775.808 ₫"),
        ] {
            assert_eq!(vnd(amount), text);
        }
    }

    #[test]
    fn api_errors_map_to_tool_errors() {
        assert_eq!(ToolError::from(ApiError::forbidden()), ToolError::Denied);
        assert!(matches!(
            ToolError::from(ApiError::not_found()),
            ToolError::NotFound(_)
        ));
        assert!(matches!(
            ToolError::from(ApiError::validation_failed("bad")),
            ToolError::InvalidArguments(m) if m == "bad"
        ));
        assert!(matches!(
            ToolError::from(ApiError::internal()),
            ToolError::Failed(_)
        ));
    }
}
