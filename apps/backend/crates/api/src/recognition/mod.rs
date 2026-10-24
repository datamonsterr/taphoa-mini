//! Recognition scans (E2): `POST /v1/recognition/scans` and
//! `GET /v1/recognition/scans/{scanId}`; `/v1/segment` lives in `lib.rs`.
pub mod classify;
pub mod encoding_cache;
pub mod handlers;
pub mod pgvector;
pub mod segment_points;
pub(crate) mod service;

pub use encoding_cache::EncodingCache;
pub(crate) use handlers::router;
pub use segment_points::segment_points;
