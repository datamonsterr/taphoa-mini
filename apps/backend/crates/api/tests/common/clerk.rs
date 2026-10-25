#![allow(dead_code)]
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, jwk::JwkSet};
use rsa::{RsaPrivateKey, pkcs8::EncodePrivateKey, rand_core::OsRng, traits::PublicKeyParts};
use serde_json::{Value, json};
use std::sync::OnceLock;
use taphoa_api::{AppState, auth::ClerkVerifier};
pub const TEST_ISSUER: &str = "https://test.clerk.accounts.dev";
struct Key {
    encoding: EncodingKey,
    jwks: JwkSet,
}
fn key() -> &'static Key {
    static KEY: OnceLock<Key> = OnceLock::new();
    KEY.get_or_init(|| {
        let private = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let pem = private.to_pkcs8_pem(Default::default()).unwrap();
        Key { encoding: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
            jwks: serde_json::from_value(json!({"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"test","n":URL_SAFE_NO_PAD.encode(private.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(private.e().to_bytes_be())}]})).unwrap() }
    })
}
pub fn install(state: &mut AppState) {
    state.clerk = ClerkVerifier::from_jwks(TEST_ISSUER, vec![], key().jwks.clone());
    state.profile = Default::default();
}
pub fn clerk_token(user_id: &str, session_id: &str) -> String {
    let now = jsonwebtoken::get_current_timestamp();
    sign(json!({"sub":user_id,"sid":session_id,"iss":TEST_ISSUER,"exp":now+3600,"nbf":now-60}))
}
pub fn sign(claims: Value) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("test".into());
    encode(&header, &claims, &key().encoding).unwrap()
}
pub fn user() -> String {
    format!("user_{}", uuid::Uuid::new_v4())
}
pub fn token() -> String {
    clerk_token(&user(), &format!("sess_{}", uuid::Uuid::new_v4()))
}
