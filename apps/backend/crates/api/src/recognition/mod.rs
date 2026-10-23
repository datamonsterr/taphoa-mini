//! Recognition scans (E2): `POST /v1/recognition/scans` and
//! `GET /v1/recognition/scans/{scanId}`; `/v1/segment` lives in `lib.rs`.
pub mod classify;
pub mod handlers;
pub mod pgvector;
pub(crate) mod service;

pub(crate) use handlers::router;
