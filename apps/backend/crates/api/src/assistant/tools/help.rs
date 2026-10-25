//! Help tool (batch T5): search_help, over the Vietnamese articles in `assistant/help/`.
use super::Tool;
use std::sync::Arc;

pub fn all() -> Vec<Arc<dyn Tool>> {
    Vec::new()
}
