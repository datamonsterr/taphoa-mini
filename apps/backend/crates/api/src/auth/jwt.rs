use super::{Actor, Role};
use crate::error::{ApiError, ApiResult};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ACCESS_TOKEN_TTL_SECS: u64 = 900;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub sid: Uuid,
    pub store: Uuid,
    pub role: Role,
    pub enroll: bool,
    pub exp: u64,
    pub iat: u64,
}
#[derive(Clone)]
pub struct JwtKeys {
    encoding: EncodingKey,
    decoding: DecodingKey,
}
impl JwtKeys {
    pub fn from_secret(secret: &[u8]) -> Self {
        Self {
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
        }
    }
    pub fn issue(&self, actor: &Actor) -> (String, u64) {
        let now = jsonwebtoken::get_current_timestamp();
        let claims = Claims {
            sub: actor.member_id,
            sid: actor.session_id,
            store: actor.store_id,
            role: actor.role,
            enroll: actor.can_enroll,
            exp: now + ACCESS_TOKEN_TTL_SECS,
            iat: now,
        };
        // HS256 with an in-memory key and these fixed claims has no fallible I/O or serialization.
        let token = encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .expect("HS256 signing with serializable claims");
        (token, ACCESS_TOKEN_TTL_SECS)
    }
    pub fn verify(&self, token: &str) -> ApiResult<Actor> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        let claims = decode::<Claims>(token, &self.decoding, &validation)
            .map_err(|_| ApiError::unauthorized())?
            .claims;
        if claims.exp <= jsonwebtoken::get_current_timestamp() {
            return Err(ApiError::unauthorized());
        }
        Ok(Actor {
            member_id: claims.sub,
            session_id: claims.sid,
            store_id: claims.store,
            role: claims.role,
            can_enroll: claims.enroll,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_expiry_signature_and_algorithm() {
        let keys = JwtKeys::from_secret(&[1; 32]);
        let actor = Actor {
            member_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            store_id: Uuid::new_v4(),
            role: Role::Lead,
            can_enroll: true,
        };
        let (token, expires) = keys.issue(&actor);
        assert_eq!(expires, 900);
        assert_eq!(keys.verify(&token).unwrap(), actor);
        assert!(JwtKeys::from_secret(&[2; 32]).verify(&token).is_err());
        let mut claims =
            decode::<Claims>(&token, &keys.decoding, &Validation::new(Algorithm::HS256))
                .unwrap()
                .claims;
        claims.exp = jsonwebtoken::get_current_timestamp() - 1;
        let expired = encode(&Header::new(Algorithm::HS256), &claims, &keys.encoding).unwrap();
        assert_eq!(keys.verify(&expired).unwrap_err().code, "unauthorized");
        claims.exp += 1000;
        let wrong_alg = encode(&Header::new(Algorithm::HS384), &claims, &keys.encoding).unwrap();
        assert!(keys.verify(&wrong_alg).is_err());
        assert!(keys.verify("malformed").is_err());
    }
}
