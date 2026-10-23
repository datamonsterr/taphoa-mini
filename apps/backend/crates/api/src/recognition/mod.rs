//! Recognition scans (E2): `POST /v1/recognition/scans`,
//! `GET /v1/recognition/scans/{scanId}` and the `/v1/segment` skeleton live in
//! `lib.rs`; this module hosts the scan pipeline.
pub mod classify;
pub mod handlers;
pub(crate) mod service;

pub(crate) use handlers::router;
