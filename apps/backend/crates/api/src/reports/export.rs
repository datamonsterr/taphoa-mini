//! Transaction downloads. Amounts are whole VND and timestamps use the store timezone.
use super::{Range, query};
use crate::{
    ApiError, ApiResult, AppState,
    auth::{Action, Actor, data::pool},
    time::STORE_TZ,
};
use axum::{
    extract::{Query, State, rejection::QueryRejection},
    http::header,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_xlsxwriter::{Workbook, XlsxError};
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Format {
    Csv,
    #[default]
    Xlsx,
}
#[derive(Deserialize)]
pub(super) struct Params {
    #[serde(flatten)]
    range: Range,
    #[serde(default)]
    format: Format,
}
#[derive(sqlx::FromRow)]
struct Transaction {
    typ: String,
    business_date: NaiveDate,
    at: DateTime<Utc>,
    code_or_category: String,
    payment: String,
    amount: i64,
    credit_amount: i64,
    status: String,
    member: String,
}
/// `amount` is the full sale total and `credit_amount` the part of it left on credit, so a partial
/// credit cash sale is not mistaken for a full cash sale. Repayments are positive cash or transfer
/// received on a debt; no customer name or phone is exported.
const HEADERS: [&str; 9] = [
    "type",
    "business_date",
    "time",
    "code_or_category",
    "payment_method/paid_with",
    "amount",
    "credit_amount",
    "status",
    "member name",
];
impl Transaction {
    fn cells(&self) -> [String; 9] {
        [
            self.typ.clone(),
            self.business_date.to_string(),
            self.at
                .with_timezone(&STORE_TZ)
                .format("%H:%M:%S")
                .to_string(),
            self.code_or_category.clone(),
            self.payment.clone(),
            self.amount.to_string(),
            self.credit_amount.to_string(),
            self.status.clone(),
            self.member.clone(),
        ]
    }
}
/// Stops spreadsheets from running a text cell as a formula (CSV injection): a cell whose first
/// character, after any leading spaces, is `=`, `+`, `-`, `@`, tab or CR gets a `'` prefix.
fn neutralize_formula(value: &str) -> String {
    let first = value.trim_start_matches(' ').chars().next();
    if matches!(first, Some('=' | '+' | '-' | '@' | '\t' | '\r')) {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}
/// Columns 5 and 6 are amounts: real numbers that may be negative and are not text.
fn is_numeric_column(col: usize) -> bool {
    col == 5 || col == 6
}
fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}
fn csv(rows: &[Transaction]) -> Vec<u8> {
    let mut result = String::from("\u{feff}");
    result.push_str(&HEADERS.join(","));
    result.push_str("\r\n");
    for row in rows {
        result.push_str(
            &row.cells()
                .iter()
                .enumerate()
                .map(|(col, s)| {
                    if is_numeric_column(col) {
                        csv_escape(s)
                    } else {
                        csv_escape(&neutralize_formula(s))
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
        );
        result.push_str("\r\n");
    }
    result.into_bytes()
}
fn xlsx(rows: &[Transaction]) -> Result<Vec<u8>, XlsxError> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("Transactions")?;
    for (col, header) in HEADERS.iter().enumerate() {
        worksheet.write_string(0, col as u16, *header)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let index = u32::try_from(index + 1).map_err(|_| XlsxError::RowColumnLimitError)?;
        for (col, value) in row.cells().into_iter().enumerate() {
            match col {
                5 => worksheet.write_number(index, col as u16, row.amount as f64)?,
                6 => worksheet.write_number(index, col as u16, row.credit_amount as f64)?,
                _ => worksheet.write_string(index, col as u16, value)?,
            };
        }
    }
    workbook.save_to_buffer()
}
pub(super) async fn transactions(
    State(state): State<AppState>,
    actor: Actor,
    params: Result<Query<Params>, QueryRejection>,
) -> ApiResult<Response> {
    actor.require(Action::Exports)?;
    let p = query(params)?;
    p.range.validate()?;
    let rows: Vec<Transaction> = sqlx::query_as(
        r#"
        SELECT * FROM (
            SELECT 'sale'::text typ,s.business_date,s.sold_at at,s.code code_or_category,
                s.payment_method payment,s.total amount,s.credit_amount credit_amount,s.status,
                m.display_name member,s.id
            FROM sales s JOIN members m ON m.id=s.member_id AND m.store_id=s.store_id
            WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3
            UNION ALL
            SELECT 'expense',e.business_date,e.spent_at,e.category,e.paid_with,e.amount,0::bigint,
                'completed',m.display_name,e.id
            FROM expenses e JOIN members m ON m.id=e.member_id AND m.store_id=e.store_id
            WHERE e.store_id=$1 AND e.business_date BETWEEN $2 AND $3 AND e.deleted_at IS NULL
            UNION ALL
            SELECT 'repayment',d.business_date,d.created_at,'debt',COALESCE(d.method,''),-d.amount,0::bigint,
                'completed',m.display_name,d.id
            FROM debt_entries d JOIN members m ON m.id=d.member_id AND m.store_id=d.store_id
            WHERE d.store_id=$1 AND d.business_date BETWEEN $2 AND $3 AND d.kind='repayment'
        ) t ORDER BY business_date,at,typ,id
    "#,
    )
    .bind(actor.store_id)
    .bind(p.range.from)
    .bind(p.range.to)
    .fetch_all(pool(&state)?)
    .await?;
    let (body, content_type, extension) = match p.format {
        Format::Csv => (csv(&rows), "text/csv; charset=utf-8", "csv"),
        Format::Xlsx => {
            let body = tokio::task::spawn_blocking(move || xlsx(&rows))
                .await
                .map_err(|_| ApiError::internal())?
                .map_err(|error| {
                    tracing::error!(%error,"xlsx export failed");
                    ApiError::internal()
                })?;
            (
                body,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "xlsx",
            )
        }
    };
    let disposition = format!(
        "attachment; filename=\"transactions-{}-{}.{}\"",
        p.range.from, p.range.to, extension
    );
    Ok((
        [
            (header::CONTENT_TYPE, content_type.to_owned()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_escaping_preserves_utf8_quotes_and_newlines() {
        assert_eq!(csv_escape("Tạp hóa"), "Tạp hóa");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("a\"b\r\nc"), "\"a\"\"b\r\nc\"");
        assert!(csv(&[]).starts_with(&[0xef, 0xbb, 0xbf]));
    }
    #[test]
    fn csv_neutralizes_formula_cells_but_keeps_negative_amounts() {
        for risky in ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "  =cmd"] {
            assert!(neutralize_formula(risky).starts_with('\''), "{risky:?}");
        }
        for safe in ["Lead", "a=b", "", "1-2", "Tạp hóa"] {
            assert_eq!(neutralize_formula(safe), safe);
        }
        let row = Transaction {
            typ: "sale".into(),
            business_date: NaiveDate::from_ymd_opt(2026, 3, 5).unwrap(),
            at: DateTime::parse_from_rfc3339("2026-03-05T03:00:00Z")
                .unwrap()
                .into(),
            code_or_category: "=HYPERLINK(\"http://x\",\"y\")".into(),
            payment: "cash".into(),
            amount: -5000,
            credit_amount: 0,
            status: "completed".into(),
            member: "=2+5".into(),
        };
        let text = String::from_utf8(csv(&[row])).unwrap();
        assert!(
            text.ends_with(
                "\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\",cash,-5000,0,completed,'=2+5\r\n"
            ),
            "{text}"
        );
    }
    #[test]
    fn csv_row_has_credit_amount_after_amount_and_matches_headers() {
        let row = Transaction {
            typ: "sale".into(),
            business_date: NaiveDate::from_ymd_opt(2026, 3, 5).unwrap(),
            at: DateTime::parse_from_rfc3339("2026-03-05T03:00:00Z")
                .unwrap()
                .into(),
            code_or_category: "S-1".into(),
            payment: "cash".into(),
            amount: 30_000,
            credit_amount: 12_000,
            status: "completed".into(),
            member: "Lead".into(),
        };
        assert_eq!(row.cells().len(), HEADERS.len());
        assert_eq!(
            HEADERS[5..7],
            ["amount", "credit_amount"],
            "credit_amount sits right after amount"
        );
        let text = String::from_utf8(csv(&[row])).unwrap();
        assert!(
            text.ends_with("sale,2026-03-05,10:00:00,S-1,cash,30000,12000,completed,Lead\r\n"),
            "{text}"
        );
    }
}
