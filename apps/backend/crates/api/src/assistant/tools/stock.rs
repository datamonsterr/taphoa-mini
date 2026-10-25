//! Stock read tools (batch T4): search_products, get_stock_levels, get_restock_plan (with the
//! `restock_list` card), get_dead_stock and get_supplier_prices.
use super::Tool;
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    Vec::new()
}
