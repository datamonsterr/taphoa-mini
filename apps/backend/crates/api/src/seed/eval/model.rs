//! Plain-data description of the eval store. `build` produces it without touching a database;
//! `insert` writes it in one transaction.
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct Dataset {
    pub today: NaiveDate,
    pub first_day: NaiveDate,
    pub now: DateTime<Utc>,
    pub store: StoreRow,
    pub identity: Identity,
    pub categories: Vec<CategoryRow>,
    pub products: Vec<ProductRow>,
    pub units: Vec<UnitRow>,
    pub images: Vec<ImageRow>,
    pub product_images: Vec<ProductImageRow>,
    pub price_history: Vec<PriceHistoryRow>,
    pub scans: Vec<ScanRow>,
    pub detections: Vec<DetectionRow>,
    pub sales: Vec<SaleRow>,
    pub sale_lines: Vec<SaleLineRow>,
    pub expenses: Vec<ExpenseRow>,
    pub purchase_lines: Vec<PurchaseLineRow>,
    pub receipts: Vec<ReceiptRow>,
    pub receipt_lines: Vec<ReceiptLineRow>,
    pub movements: Vec<MovementRow>,
    pub day_closes: Vec<DayCloseRow>,
    pub alerts: Vec<AlertRow>,
}

/// Store settings that are not identity. The row itself is written by `insert_identity`
/// together with the credentials.
#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct StoreRow {
    pub id: Uuid,
    pub name: &'static str,
    pub bank_bin: &'static str,
    pub bank_short_name: &'static str,
    pub bank_account_number: &'static str,
    pub bank_account_name: &'static str,
    pub margin_threshold_pct: i32,
    pub low_stock_threshold: i32,
    pub created_at: DateTime<Utc>,
}

/// Everything epic X1 replaces with Clerk: members, credentials, sessions and invites.
#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct Identity {
    pub recovery_code: String,
    pub members: Vec<MemberRow>,
    pub invites: Vec<InviteRow>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct MemberRow {
    pub id: Uuid,
    pub key: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    pub can_enroll: bool,
    pub pin: Option<&'static str>,
    pub session: Option<SessionRow>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct SessionRow {
    pub id: Uuid,
    pub device: &'static str,
    pub platform: &'static str,
    pub refresh_token: &'static str,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct InviteRow {
    pub id: Uuid,
    pub token: String,
    pub role: &'static str,
    pub can_enroll: bool,
    pub created_by: Uuid,
    pub used_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct CategoryRow {
    pub id: Uuid,
    pub name: &'static str,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ProductRow {
    pub id: Uuid,
    pub name: &'static str,
    pub category: Option<Uuid>,
    pub base_unit: &'static str,
    pub price: i64,
    pub cost: i64,
    pub barcode: Option<String>,
    /// Final stock; `None` for untracked products.
    pub stock: Option<i32>,
    pub threshold: Option<i32>,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct UnitRow {
    pub id: Uuid,
    pub product: Uuid,
    pub name: &'static str,
    pub quantity_in_base: i32,
    pub price: i64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ImageRow {
    pub id: Uuid,
    pub object_key: String,
    pub purpose: &'static str,
    pub uploaded_by: Uuid,
    pub created_at: DateTime<Utc>,
}

/// A reference photo. Each one has one embedding row.
#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ProductImageRow {
    pub product: Uuid,
    pub image: Uuid,
    pub position: i16,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct PriceHistoryRow {
    pub id: Uuid,
    pub product: Uuid,
    pub unit: Option<Uuid>,
    pub field: &'static str,
    pub old: Option<i64>,
    pub new: i64,
    pub source: &'static str,
    pub changed_by: Uuid,
    pub changed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ScanRow {
    pub id: Uuid,
    pub image: Uuid,
    pub member: Uuid,
    pub sale: Uuid,
    pub multi: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct DetectionRow {
    pub id: Uuid,
    pub scan: Uuid,
    pub position: i16,
    pub matched: &'static str,
    /// Product ids with similarity, best first.
    pub candidates: Vec<(Uuid, f32)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct VoidRow {
    pub reason: &'static str,
    pub by: Uuid,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct SaleRow {
    pub id: Uuid,
    pub code: String,
    pub member: Uuid,
    pub sold_at: DateTime<Utc>,
    pub date: NaiveDate,
    pub cash: bool,
    pub cash_received: Option<i64>,
    pub total: i64,
    pub memo: Option<String>,
    pub void: Option<VoidRow>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ReviewRow {
    pub status: &'static str,
    pub reason: &'static str,
    pub action: Option<&'static str>,
    pub product: Option<Uuid>,
    pub by: Option<Uuid>,
    pub at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct SaleLineRow {
    pub id: Uuid,
    pub sale: Uuid,
    pub position: i16,
    pub product: Option<Uuid>,
    pub unit: Option<Uuid>,
    pub source: &'static str,
    pub quantity: i32,
    pub unit_price: i64,
    pub quantity_in_base: i32,
    pub label: Option<&'static str>,
    pub detection: Option<Uuid>,
    pub suggested: Option<Uuid>,
    pub mismatch: bool,
    pub review: Option<ReviewRow>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ExpenseRow {
    pub id: Uuid,
    pub member: Uuid,
    pub spent_at: DateTime<Utc>,
    pub date: NaiveDate,
    pub amount: i64,
    pub category: &'static str,
    pub paid_with: &'static str,
    pub image: Option<Uuid>,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct PurchaseLineRow {
    pub id: Uuid,
    pub expense: Uuid,
    pub product: Uuid,
    pub quantity: i32,
    pub unit_cost: i64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ReceiptRow {
    pub id: Uuid,
    pub member: Uuid,
    pub image: Uuid,
    pub status: &'static str,
    pub supplier: usize,
    pub ocr_text: String,
    pub parser: &'static str,
    pub model: Option<&'static str>,
    pub timings: Value,
    pub total: i64,
    pub expense: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub confirmed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct ReceiptLineRow {
    pub id: Uuid,
    pub receipt: Uuid,
    pub position: i32,
    pub raw_text: String,
    pub product_name: String,
    pub quantity: i32,
    pub cost: i64,
    pub product: Option<Uuid>,
    pub confidence: Option<f32>,
    /// Candidate product id, display name and probability.
    pub candidates: Vec<(Uuid, String, f32)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct MovementRow {
    pub id: Uuid,
    pub product: Uuid,
    pub delta: i32,
    pub after: i32,
    pub reason: &'static str,
    pub ref_id: Option<Uuid>,
    pub member: Uuid,
    pub note: Option<&'static str>,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct DayCloseRow {
    pub date: NaiveDate,
    pub opening_float: i64,
    pub cash_sales: i64,
    pub cash_refunds: i64,
    pub cash_expenses: i64,
    pub expected_cash: i64,
    pub counted_cash: i64,
    pub transfer_revenue: i64,
    pub note: Option<&'static str>,
    pub closed_by: Uuid,
    pub closed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct AlertRow {
    pub id: Uuid,
    pub product: Uuid,
    pub expense: Option<Uuid>,
    pub cost: i64,
    pub price: i64,
    pub margin_pct: f64,
    pub suggested: i64,
    pub status: &'static str,
    pub resolved_by: Option<Uuid>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}
