//! Store operations read tools (batch T5): explain_day_close, list_review_queue,
//! suggest_manual_line_matches, get_recognition_health, get_member_activity, detect_anomalies,
//! suggest_low_stock_thresholds, get_setup_checklist, get_receipt (with the `receipt_lines` card)
//! and start_export.
use super::Tool;
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    Vec::new()
}
