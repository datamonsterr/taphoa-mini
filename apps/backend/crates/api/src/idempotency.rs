use crate::error::{ApiError, ApiResult};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Sorted recursively, compact JSON; array order remains significant.
pub fn request_hash(value: &Value) -> [u8; 32] {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let sorted: BTreeMap<_, _> =
                    map.iter().map(|(k, v)| (k.clone(), canonical(v))).collect();
                Value::Object(sorted.into_iter().collect())
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            value => value.clone(),
        }
    }
    Sha256::digest(serde_json::to_vec(&canonical(value)).expect("JSON value serialization")).into()
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Idempotent<T> {
    Created(T),
    Replay(T),
}
impl<T> Idempotent<T> {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Created(_) => StatusCode::CREATED,
            Self::Replay(_) => StatusCode::OK,
        }
    }
    pub fn into_inner(self) -> T {
        match self {
            Self::Created(value) | Self::Replay(value) => value,
        }
    }
    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Idempotent<U> {
        match self {
            Self::Created(value) => Idempotent::Created(f(value)),
            Self::Replay(value) => Idempotent::Replay(f(value)),
        }
    }
}
impl<T: Serialize> IntoResponse for Idempotent<T> {
    fn into_response(self) -> Response {
        (self.status(), Json(self.into_inner())).into_response()
    }
}
pub fn check(stored_hash: &[u8], new_hash: &[u8; 32]) -> ApiResult<()> {
    if stored_hash == new_hash {
        Ok(())
    } else {
        Err(ApiError::conflict(
            "id_conflict",
            "id already used with a different request",
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn canonical_hash_table() {
        for (a, b, same) in [
            (r#"{"b":2,"a":1}"#, r#"{"a":1,"b":2}"#, true),
            (r#"{"x":[{"z":1,"a":2}]}"#, r#"{"x":[{"a":2,"z":1}]}"#, true),
            ("[1,2]", "[2,1]", false),
            ("null", "false", false),
        ] {
            assert_eq!(
                request_hash(&serde_json::from_str(a).unwrap())
                    == request_hash(&serde_json::from_str(b).unwrap()),
                same
            );
        }
        assert_eq!(
            hex::encode(request_hash(&json!({}))),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }
    #[test]
    fn mismatch_and_replay() {
        let hash = request_hash(&json!({"a":1}));
        assert!(check(&hash, &hash).is_ok());
        for stored in [&[0; 32][..], &[][..]] {
            let error = check(stored, &hash).unwrap_err();
            assert_eq!(error.code, "id_conflict");
            assert_eq!(error.status, StatusCode::CONFLICT);
        }
        assert_eq!(Idempotent::Created(1).status(), StatusCode::CREATED);
        assert_eq!(Idempotent::Replay(1).map(|n| n + 1).into_inner(), 2);
        assert_eq!(Idempotent::Replay(1).status(), StatusCode::OK);
    }
}
