//! Propose tools (batch T6): propose_stock_adjustment, propose_expense, propose_price_change,
//! propose_threshold_update, propose_reorder_list, propose_receipt_line_update and
//! propose_receipt_confirm, plus propose_invite. X5 adds the debt proposals in `tools/debts.rs`.
use super::Tool;
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    Vec::new()
}
