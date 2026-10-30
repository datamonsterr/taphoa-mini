use crate::error::{ApiError, ApiResult};
use axum::{
    extract::{FromRequestParts, Query},
    http::request::Parts,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Debug, Clone, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct PageParams {
    #[serde(default = "default_limit", deserialize_with = "deserialize_limit")]
    pub limit: u32,
    pub cursor: Option<String>,
}
fn default_limit() -> u32 {
    50
}
fn deserialize_limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    Ok(i64::deserialize(d)?.clamp(1, 200) as u32)
}
impl Default for PageParams {
    fn default() -> Self {
        Self {
            limit: 50,
            cursor: None,
        }
    }
}
impl<S: Send + Sync> FromRequestParts<S> for PageParams {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> ApiResult<Self> {
        Query::<Self>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| value)
            .map_err(ApiError::from)
    }
}
pub fn encode_cursor<T: Serialize>(key: &T) -> Result<String, serde_json::Error> {
    serde_json::to_vec(key).map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
}
pub fn decode_cursor<T: DeserializeOwned>(cursor: &str) -> ApiResult<T> {
    let invalid = || ApiError::bad_request("invalid_cursor", "invalid pagination cursor");
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    #[tokio::test]
    async fn defaults_clamps_and_rejects_bad_query() {
        for (query, limit) in [
            ("", 50),
            ("?limit=0", 1),
            ("?limit=-8", 1),
            ("?limit=999", 200),
            ("?limit=12&cursor=abc", 12),
        ] {
            let (mut parts, _) = Request::get(format!("/{query}"))
                .body(())
                .unwrap()
                .into_parts();
            let page = PageParams::from_request_parts(&mut parts, &())
                .await
                .unwrap();
            assert_eq!(page.limit, limit);
        }
        let (mut parts, _) = Request::get("/?limit=wrong").body(()).unwrap().into_parts();
        assert!(
            PageParams::from_request_parts(&mut parts, &())
                .await
                .is_err()
        );
    }
    #[test]
    fn opaque_round_trip_and_invalid_cursors() {
        let key = (123_i64, "a/b+字");
        let cursor = encode_cursor(&key).unwrap();
        assert!(!cursor.contains(['=', '+', '/']));
        assert_eq!(
            decode_cursor::<(i64, String)>(&cursor).unwrap(),
            (123, key.1.into())
        );
        for invalid in ["", "%%%", "e30=", "bm90LWpzb24", "e30"] {
            assert_eq!(
                decode_cursor::<u64>(invalid).unwrap_err().code,
                "invalid_cursor"
            );
        }
        assert_eq!(
            serde_json::to_value(Page::<u32> {
                items: vec![],
                next_cursor: None
            })
            .unwrap(),
            serde_json::json!({"items":[], "next_cursor":null})
        );
    }
}
