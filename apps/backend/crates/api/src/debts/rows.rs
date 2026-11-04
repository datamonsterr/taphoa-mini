//! Shared database projections and JSON shaping for HTTP and the sync feed.
use super::{aging, db_error};
use crate::ApiResult;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub(crate) struct CustomerRow {
    pub id: Uuid,
    pub name: String,
    pub phone: Option<String>,
    pub note: Option<String>,
    pub credit_limit: Option<i64>,
    pub balance: i64,
    pub oldest_debt_date: Option<NaiveDate>,
    pub archived_at: Option<DateTime<Utc>>,
    pub request_hash: Vec<u8>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
impl CustomerRow {
    pub(crate) fn json(&self, today: NaiveDate) -> Value {
        json!({"id":self.id,"name":self.name,"phone":self.phone,"note":self.note,
            "credit_limit":self.credit_limit,"balance":self.balance,"oldest_debt_date":self.oldest_debt_date,
            "debt_age_days":aging::debt_age_days(self.oldest_debt_date,today),
            "overdue":aging::overdue(self.oldest_debt_date,today),"archived":self.archived_at.is_some(),
            "created_at":self.created_at,"updated_at":self.updated_at})
    }
}
#[derive(Debug, Serialize, sqlx::FromRow)]
pub(crate) struct DebtEntryRow {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub kind: String,
    pub amount: i64,
    pub balance_after: i64,
    pub sale_id: Option<Uuid>,
    pub method: Option<String>,
    pub reason: Option<String>,
    pub member_id: Uuid,
    pub business_date: NaiveDate,
    pub created_at: DateTime<Utc>,
}
impl DebtEntryRow {
    pub(crate) fn json(&self) -> Value {
        serde_json::to_value(self).expect("debt entry serialization")
    }
}
pub(crate) async fn load_customers(
    conn: &mut PgConnection,
    store: Uuid,
    ids: &[Uuid],
    today: NaiveDate,
) -> ApiResult<Vec<(Uuid, Value)>> {
    let rows: Vec<CustomerRow> =
        sqlx::query_as("SELECT * FROM customers WHERE store_id=$1 AND id=ANY($2)")
            .bind(store)
            .bind(ids)
            .fetch_all(conn)
            .await
            .map_err(db_error)?;
    Ok(rows.into_iter().map(|r| (r.id, r.json(today))).collect())
}
pub(crate) async fn load_entries(
    conn: &mut PgConnection,
    store: Uuid,
    ids: &[Uuid],
) -> ApiResult<Vec<(Uuid, Value)>> {
    let rows: Vec<DebtEntryRow> =
        sqlx::query_as("SELECT * FROM debt_entries WHERE store_id=$1 AND id=ANY($2)")
            .bind(store)
            .bind(ids)
            .fetch_all(conn)
            .await
            .map_err(db_error)?;
    Ok(rows.into_iter().map(|r| (r.id, r.json())).collect())
}
