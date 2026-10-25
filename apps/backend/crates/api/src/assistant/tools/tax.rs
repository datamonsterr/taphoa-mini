//! Tax tool (batch T5): get_tax_overview, over the versioned table in `assistant/rules/tax_vn.toml`.
use super::Tool;
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    Vec::new()
}
