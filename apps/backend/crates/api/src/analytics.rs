//! Backend analytics sink. The PostHog implementation arrives in X6.
//!
//! Every PostHog capture goes through [`Analytics::capture_event`]: typed
//! [`ProductEvent`]s (via [`CaptureEvent::product`]) and LLM analytics events such as
//! `$ai_trace`, `$ai_span`, `$ai_generation` or `assistant_quota_hit`.
//!
//! Product-event properties must never carry names, emails, phone numbers, bank numbers,
//! tokens or OCR text. Message content is allowed only in `$ai_*` events, and callers mask
//! 9-15 digit sequences there first. Common environment/app_version/language props belong to X6.
//!
//! X0 choices: enrollment sources are enroll, quick_enroll, review_queue and receipt;
//! debt methods are cash, transfer, credit_sale and adjustment. Amount buckets use
//! absolute dong amounts with thresholds 50_000, 200_000 and 1_000_000; day-close
//! differences are zero, small (absolute difference <= 20_000), or large.
//! Action decisions are confirmed, rejected, expired or failed. Payment methods
//! include credit for X5. ScanPurpose mirrors the private recognition domain enum.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

pub use crate::{auth::Role, recognition::classify::MatchClass};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrollmentSource {
    Enroll,
    QuickEnroll,
    ReviewQueue,
    Receipt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanPurpose {
    Checkout,
    Enrollment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    Cash,
    Transfer,
    Credit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptVia {
    Chat,
    Form,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeVia {
    Manual,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StockReason {
    Receipt,
    Sale,
    SaleVoid,
    Adjustment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpenseCategory {
    NhapHang,
    Dien,
    Nuoc,
    Khac,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DifferenceBucket {
    Zero,
    Small,
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DebtMethod {
    Cash,
    Transfer,
    CreditSale,
    Adjustment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    StockAdjustment,
    Expense,
    PriceChange,
    ThresholdUpdate,
    ReorderList,
    ReceiptLineUpdate,
    ReceiptConfirm,
    Repayment,
    DebtAdjustment,
    Invite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionDecision {
    Confirmed,
    Rejected,
    Expired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AmountBucket {
    #[serde(rename = "lt_50k")]
    Lt50k,
    #[serde(rename = "50k_200k")]
    From50kTo200k,
    #[serde(rename = "200k_1m")]
    From200kTo1m,
    #[serde(rename = "gte_1m")]
    Gte1m,
}

impl AmountBucket {
    /// Bucket the magnitude; signed debt adjustments never expose raw amounts.
    pub fn from_dong(amount: i64) -> Self {
        match amount.unsigned_abs() {
            0..50_000 => Self::Lt50k,
            50_000..200_000 => Self::From50kTo200k,
            200_000..1_000_000 => Self::From200kTo1m,
            _ => Self::Gte1m,
        }
    }
}

impl DifferenceBucket {
    pub fn from_dong(difference: i64) -> Self {
        match difference.unsigned_abs() {
            0 => Self::Zero,
            1..=20_000 => Self::Small,
            _ => Self::Large,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ProductEvent {
    StoreCreated,
    MemberJoined {
        role: Role,
        can_enroll: bool,
    },
    ProductEnrolled {
        reference_count: u32,
        source: EnrollmentSource,
    },
    ScanCompleted {
        purpose: ScanPurpose,
        match_class: MatchClass,
        latency_ms: u64,
    },
    SaleCompleted {
        total: i64,
        line_count: u32,
        payment_method: PaymentMethod,
        has_credit: bool,
        manual_lines: u32,
    },
    SaleVoided {
        same_day: bool,
    },
    ReceiptScanned {
        line_count: u32,
        matched_lines: u32,
        latency_ms: u64,
    },
    ReceiptConfirmed {
        line_count: u32,
        via: ReceiptVia,
    },
    StockAdjusted {
        reason: StockReason,
        via: ChangeVia,
    },
    ExpenseAdded {
        category: ExpenseCategory,
        via: ChangeVia,
    },
    PriceChanged {
        via: ChangeVia,
    },
    DayClosed {
        difference_bucket: DifferenceBucket,
    },
    CustomerCreated,
    DebtRecorded {
        amount_bucket: AmountBucket,
        method: DebtMethod,
    },
    DebtRepaid {
        amount_bucket: AmountBucket,
        method: DebtMethod,
    },
    DebtAdjusted {
        amount_bucket: AmountBucket,
        method: DebtMethod,
    },
    AssistantActionProposed {
        kind: ActionKind,
    },
    AssistantActionDecided {
        kind: ActionKind,
        decision: ActionDecision,
    },
}

impl ProductEvent {
    pub fn name(&self) -> &'static str {
        match self {
            Self::StoreCreated => "store_created",
            Self::MemberJoined { .. } => "member_joined",
            Self::ProductEnrolled { .. } => "product_enrolled",
            Self::ScanCompleted { .. } => "scan_completed",
            Self::SaleCompleted { .. } => "sale_completed",
            Self::SaleVoided { .. } => "sale_voided",
            Self::ReceiptScanned { .. } => "receipt_scanned",
            Self::ReceiptConfirmed { .. } => "receipt_confirmed",
            Self::StockAdjusted { .. } => "stock_adjusted",
            Self::ExpenseAdded { .. } => "expense_added",
            Self::PriceChanged { .. } => "price_changed",
            Self::DayClosed { .. } => "day_closed",
            Self::CustomerCreated => "customer_created",
            Self::DebtRecorded { .. } => "debt_recorded",
            Self::DebtRepaid { .. } => "debt_repaid",
            Self::DebtAdjusted { .. } => "debt_adjusted",
            Self::AssistantActionProposed { .. } => "assistant_action_proposed",
            Self::AssistantActionDecided { .. } => "assistant_action_decided",
        }
    }

    pub fn properties(&self) -> Map<String, Value> {
        match self {
            Self::StoreCreated => Map::new(),
            Self::MemberJoined { role, can_enroll } => json!({"role": role, "can_enroll": can_enroll}).as_object().expect("event properties are an object").clone(),
            Self::ProductEnrolled { reference_count, source } => json!({"reference_count": reference_count, "source": source}).as_object().expect("event properties are an object").clone(),
            Self::ScanCompleted { purpose, match_class, latency_ms } => json!({"purpose": purpose, "match_class": match_class, "latency_ms": latency_ms}).as_object().expect("event properties are an object").clone(),
            Self::SaleCompleted { total, line_count, payment_method, has_credit, manual_lines } => json!({"total": total, "line_count": line_count, "payment_method": payment_method, "has_credit": has_credit, "manual_lines": manual_lines}).as_object().expect("event properties are an object").clone(),
            Self::SaleVoided { same_day } => json!({"same_day": same_day}).as_object().expect("event properties are an object").clone(),
            Self::ReceiptScanned { line_count, matched_lines, latency_ms } => json!({"line_count": line_count, "matched_lines": matched_lines, "latency_ms": latency_ms}).as_object().expect("event properties are an object").clone(),
            Self::ReceiptConfirmed { line_count, via } => json!({"line_count": line_count, "via": via}).as_object().expect("event properties are an object").clone(),
            Self::StockAdjusted { reason, via } => json!({"reason": reason, "via": via}).as_object().expect("event properties are an object").clone(),
            Self::ExpenseAdded { category, via } => json!({"category": category, "via": via}).as_object().expect("event properties are an object").clone(),
            Self::PriceChanged { via } => json!({"via": via}).as_object().expect("event properties are an object").clone(),
            Self::DayClosed { difference_bucket } => json!({"difference_bucket": difference_bucket}).as_object().expect("event properties are an object").clone(),
            Self::CustomerCreated => Map::new(),
            Self::DebtRecorded { amount_bucket, method } => json!({"amount_bucket": amount_bucket, "method": method}).as_object().expect("event properties are an object").clone(),
            Self::DebtRepaid { amount_bucket, method } => json!({"amount_bucket": amount_bucket, "method": method}).as_object().expect("event properties are an object").clone(),
            Self::DebtAdjusted { amount_bucket, method } => json!({"amount_bucket": amount_bucket, "method": method}).as_object().expect("event properties are an object").clone(),
            Self::AssistantActionProposed { kind } => json!({"kind": kind}).as_object().expect("event properties are an object").clone(),
            Self::AssistantActionDecided { kind, decision } => json!({"kind": kind, "decision": decision}).as_object().expect("event properties are an object").clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EventContext {
    /// Today the member id; X1 switches this to the Clerk user id.
    pub distinct_id: String,
    pub store_id: Uuid,
    pub member_id: Uuid,
    pub role: Role,
}

/// One PostHog capture call: any event name, including `$ai_*` LLM analytics events.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureEvent {
    pub distinct_id: String,
    pub event: String,
    pub properties: Map<String, Value>,
    /// PostHog groups, e.g. `{"store": "<store uuid>"}`.
    pub groups: Map<String, Value>,
}

impl CaptureEvent {
    /// Maps a typed product event: distinct_id from ctx, `groups.store` = store id,
    /// properties = event properties plus `member_id` and `role` (snake_case string, same as serde).
    ///
    /// `member_joined` carries its own `role` (the role of the joining member, not of the
    /// acting member in `ctx`); the event's own value wins over the actor's role.
    pub fn product(ctx: &EventContext, event: &ProductEvent) -> Self {
        let mut properties = Map::new();
        properties.insert("member_id".to_owned(), json!(ctx.member_id.to_string()));
        properties.insert("role".to_owned(), json!(ctx.role));
        // Own properties are inserted last so they replace the actor defaults above.
        properties.extend(event.properties());
        let mut groups = Map::new();
        groups.insert("store".to_owned(), json!(ctx.store_id.to_string()));
        Self {
            distinct_id: ctx.distinct_id.clone(),
            event: event.name().to_owned(),
            properties,
            groups,
        }
    }
}

#[async_trait]
pub trait Analytics: Send + Sync {
    /// Sends one event of any name. The PostHog sink (X6) adds `environment`, `app_version`
    /// and `language`; callers mask 9-15 digit sequences in `$ai_*` content first.
    async fn capture_event(&self, event: CaptureEvent) -> anyhow::Result<()>;

    /// Typed product event, routed through `capture_event`.
    async fn capture(&self, ctx: &EventContext, event: ProductEvent) -> anyhow::Result<()> {
        self.capture_event(CaptureEvent::product(ctx, &event)).await
    }
}

#[derive(Debug, Default)]
pub struct NoopAnalytics;

#[async_trait]
impl Analytics for NoopAnalytics {
    async fn capture_event(&self, _event: CaptureEvent) -> anyhow::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppState, auth::Role, recognition::classify::MatchClass};
    use serde_json::json;
    use std::collections::BTreeSet;

    fn samples() -> Vec<(ProductEvent, &'static [&'static str])> {
        vec![
            (ProductEvent::StoreCreated, &[]),
            (
                ProductEvent::MemberJoined {
                    role: Role::Lead,
                    can_enroll: true,
                },
                &["role", "can_enroll"],
            ),
            (
                ProductEvent::ProductEnrolled {
                    reference_count: 3,
                    source: EnrollmentSource::QuickEnroll,
                },
                &["reference_count", "source"],
            ),
            (
                ProductEvent::ScanCompleted {
                    purpose: ScanPurpose::Checkout,
                    match_class: MatchClass::Matched,
                    latency_ms: 123,
                },
                &["purpose", "match_class", "latency_ms"],
            ),
            (
                ProductEvent::SaleCompleted {
                    total: 123456,
                    line_count: 2,
                    payment_method: PaymentMethod::Cash,
                    has_credit: false,
                    manual_lines: 1,
                },
                &[
                    "total",
                    "line_count",
                    "payment_method",
                    "has_credit",
                    "manual_lines",
                ],
            ),
            (ProductEvent::SaleVoided { same_day: true }, &["same_day"]),
            (
                ProductEvent::ReceiptScanned {
                    line_count: 3,
                    matched_lines: 2,
                    latency_ms: 200,
                },
                &["line_count", "matched_lines", "latency_ms"],
            ),
            (
                ProductEvent::ReceiptConfirmed {
                    line_count: 3,
                    via: ReceiptVia::Chat,
                },
                &["line_count", "via"],
            ),
            (
                ProductEvent::StockAdjusted {
                    reason: StockReason::Adjustment,
                    via: ChangeVia::Manual,
                },
                &["reason", "via"],
            ),
            (
                ProductEvent::ExpenseAdded {
                    category: ExpenseCategory::Khac,
                    via: ChangeVia::Assistant,
                },
                &["category", "via"],
            ),
            (
                ProductEvent::PriceChanged {
                    via: ChangeVia::Manual,
                },
                &["via"],
            ),
            (
                ProductEvent::DayClosed {
                    difference_bucket: DifferenceBucket::Zero,
                },
                &["difference_bucket"],
            ),
            (ProductEvent::CustomerCreated, &[]),
            (
                ProductEvent::DebtRecorded {
                    amount_bucket: AmountBucket::Lt50k,
                    method: DebtMethod::CreditSale,
                },
                &["amount_bucket", "method"],
            ),
            (
                ProductEvent::DebtRepaid {
                    amount_bucket: AmountBucket::Gte1m,
                    method: DebtMethod::Transfer,
                },
                &["amount_bucket", "method"],
            ),
            (
                ProductEvent::DebtAdjusted {
                    amount_bucket: AmountBucket::Lt50k,
                    method: DebtMethod::Adjustment,
                },
                &["amount_bucket", "method"],
            ),
            (
                ProductEvent::AssistantActionProposed {
                    kind: ActionKind::Expense,
                },
                &["kind"],
            ),
            (
                ProductEvent::AssistantActionDecided {
                    kind: ActionKind::Expense,
                    decision: ActionDecision::Confirmed,
                },
                &["kind", "decision"],
            ),
        ]
    }

    #[test]
    fn names_match_backend_contract() {
        let expected = BTreeSet::from([
            "store_created",
            "member_joined",
            "product_enrolled",
            "scan_completed",
            "sale_completed",
            "sale_voided",
            "receipt_scanned",
            "receipt_confirmed",
            "stock_adjusted",
            "expense_added",
            "price_changed",
            "day_closed",
            "customer_created",
            "debt_recorded",
            "debt_repaid",
            "debt_adjusted",
            "assistant_action_proposed",
            "assistant_action_decided",
        ]);
        let events = samples();
        assert_eq!(events.len(), expected.len());
        assert_eq!(
            events
                .iter()
                .map(|(event, _)| event.name())
                .collect::<BTreeSet<_>>(),
            expected
        );
    }

    #[test]
    fn properties_match_backend_contract() {
        for (event, keys) in samples() {
            assert_eq!(
                event
                    .properties()
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>(),
                keys.iter().copied().collect(),
                "{}",
                event.name()
            );
        }
    }

    #[test]
    fn sale_total_is_integer_dong() {
        let (sale, _) = samples()
            .into_iter()
            .find(|(e, _)| e.name() == "sale_completed")
            .unwrap();
        assert_eq!(sale.properties()["total"].as_i64(), Some(123456));
        assert_eq!(sale.properties()["payment_method"], json!("cash"));
    }

    #[test]
    fn bucket_boundaries() {
        for (amount, expected) in [
            (0, "lt_50k"),
            (49999, "lt_50k"),
            (50000, "50k_200k"),
            (199999, "50k_200k"),
            (200000, "200k_1m"),
            (999999, "200k_1m"),
            (1000000, "gte_1m"),
            (i64::MIN, "gte_1m"),
        ] {
            assert_eq!(
                serde_json::to_value(AmountBucket::from_dong(amount)).unwrap(),
                json!(expected)
            );
        }
        for (amount, expected) in [
            (0, "zero"),
            (1, "small"),
            (-1, "small"),
            (20000, "small"),
            (-20000, "small"),
            (20001, "large"),
            (-20001, "large"),
            (i64::MIN, "large"),
        ] {
            assert_eq!(
                serde_json::to_value(DifferenceBucket::from_dong(amount)).unwrap(),
                json!(expected)
            );
        }
    }

    fn context() -> EventContext {
        let member_id = uuid::Uuid::new_v4();
        EventContext {
            distinct_id: member_id.to_string(),
            store_id: uuid::Uuid::new_v4(),
            member_id,
            role: Role::Lead,
        }
    }

    #[tokio::test]
    async fn noop_capture_succeeds() {
        NoopAnalytics
            .capture(&context(), ProductEvent::StoreCreated)
            .await
            .unwrap();
    }

    #[derive(Default)]
    struct Recorder(std::sync::Mutex<Vec<CaptureEvent>>);

    #[async_trait]
    impl Analytics for Recorder {
        async fn capture_event(&self, event: CaptureEvent) -> anyhow::Result<()> {
            self.0.lock().unwrap().push(event);
            Ok(())
        }
    }

    #[test]
    fn product_capture_event_maps_sale_completed() {
        let ctx = context();
        let sale = ProductEvent::SaleCompleted {
            total: 123456,
            line_count: 2,
            payment_method: PaymentMethod::Cash,
            has_credit: false,
            manual_lines: 1,
        };
        let captured = CaptureEvent::product(&ctx, &sale);
        assert_eq!(captured.event, "sale_completed");
        assert_eq!(captured.distinct_id, ctx.distinct_id);
        assert_eq!(
            captured.groups,
            json!({"store": ctx.store_id.to_string()})
                .as_object()
                .unwrap()
                .clone()
        );
        assert_eq!(captured.properties["total"].as_i64(), Some(123456));
        assert_eq!(
            captured.properties["member_id"],
            json!(ctx.member_id.to_string())
        );
        assert_eq!(captured.properties["role"], json!("lead"));
        assert_eq!(captured.properties["payment_method"], json!("cash"));
    }

    #[test]
    fn product_capture_event_keeps_event_role_over_actor_role() {
        let mut ctx = context();
        ctx.role = Role::Lead;
        let joined = ProductEvent::MemberJoined {
            role: Role::Seller,
            can_enroll: true,
        };
        let captured = CaptureEvent::product(&ctx, &joined);
        assert_eq!(captured.properties["role"], json!("seller"));
        assert_eq!(captured.properties["can_enroll"], json!(true));
        assert_eq!(
            captured.properties["member_id"],
            json!(ctx.member_id.to_string())
        );
    }

    #[tokio::test]
    async fn default_capture_routes_through_capture_event() {
        let recorder = Recorder::default();
        let ctx = context();
        recorder
            .capture(&ctx, ProductEvent::StoreCreated)
            .await
            .unwrap();
        let events = recorder.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            CaptureEvent::product(&ctx, &ProductEvent::StoreCreated)
        );
    }

    #[tokio::test]
    async fn ai_generation_event_passes_through_unchanged() {
        let recorder = Recorder::default();
        let event = CaptureEvent {
            distinct_id: "user_123".to_owned(),
            event: "$ai_generation".to_owned(),
            properties: json!({
                "$ai_trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
                "$ai_model": "openrouter/free",
                "$ai_input_tokens": 120,
            })
            .as_object()
            .unwrap()
            .clone(),
            groups: json!({"store": uuid::Uuid::new_v4().to_string()})
                .as_object()
                .unwrap()
                .clone(),
        };
        recorder.capture_event(event.clone()).await.unwrap();
        let events = recorder.0.lock().unwrap();
        assert_eq!(events.as_slice(), [event]);
    }

    #[tokio::test]
    async fn noop_capture_event_succeeds() {
        NoopAnalytics
            .capture_event(CaptureEvent {
                distinct_id: "user_123".to_owned(),
                event: "$ai_trace".to_owned(),
                properties: Map::new(),
                groups: Map::new(),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn default_state_has_working_analytics() {
        AppState::default()
            .analytics
            .capture(&context(), ProductEvent::StoreCreated)
            .await
            .unwrap();
    }
}
