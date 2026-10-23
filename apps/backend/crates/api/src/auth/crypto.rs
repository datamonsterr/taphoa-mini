use crate::{ApiError, ApiResult};
use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use sha2::{Digest, Sha256};

pub const RECOVERY_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
pub fn recovery_code() -> String {
    let bytes = rand::random::<[u8; 16]>();
    let mut result = String::with_capacity(19);
    for (i, byte) in bytes.iter().enumerate() {
        if i > 0 && i % 4 == 0 {
            result.push('-');
        }
        result.push(RECOVERY_ALPHABET[(byte & 31) as usize] as char);
    }
    result
}
pub fn normalize_recovery(code: &str) -> String {
    code.chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}
pub fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
pub fn opaque_token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}
pub fn invite_token() -> String {
    base32::encode(
        base32::Alphabet::Rfc4648 { padding: false },
        &rand::random::<[u8; 16]>(),
    )
}
pub async fn hash_secret(secret: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(secret.as_bytes())
            .map(|hash| hash.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
    .map_err(|_| ApiError::internal())?
}
pub async fn verify_secret(secret: String, hash: String) -> ApiResult<bool> {
    tokio::task::spawn_blocking(move || {
        let parsed = PasswordHash::new(&hash).map_err(|_| ApiError::internal())?;
        Ok(Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|_| ApiError::internal())?
}
