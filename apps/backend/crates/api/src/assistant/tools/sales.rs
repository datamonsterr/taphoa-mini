//! Sales read tools (batch T4): get_sales_summary, get_top_products, search_sales,
//! get_margin_report, forecast_demand and list_expenses.
use super::Tool;
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    Vec::new()
}
