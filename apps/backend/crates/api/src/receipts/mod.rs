//! Pure receipt parsing and catalog mapping; transport and persistence are composed by callers.
mod http;
pub use http::router;
pub mod mapping;
pub mod parse;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OcrText {
    pub text: String,
    pub confidence: f32,
    pub bbox: [f32; 4],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LineCandidate {
    pub position: usize,
    pub raw_text: String,
    pub product_name: String,
    pub quantity: i32,
    pub cost: i64,
    pub unit_price: Option<i64>,
}

pub use mapping::{
    CANDIDATE_PREFILTER_SQL, CatalogCandidate, MappedLine, MappingOutcome, MatchCandidate,
    build_request, map_lines,
};
pub use parse::parse_lines;
