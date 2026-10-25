//! Clerk session JWT verification, independent of membership and request extraction.
pub use crate::config::ClerkSettings;
use crate::error::{ApiError, ApiResult};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::Instant};

const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClerkClaims {
    pub user_id: String,
    pub session_id: String,
}

#[derive(Deserialize)]
struct SessionClaims {
    sub: String,
    sid: String,
    iss: String,
    azp: Option<String>,
    sts: Option<String>,
}

/// Clones share both cached keys and the refresh throttle.
#[derive(Clone)]
pub struct ClerkVerifier {
    inner: Arc<VerifierInner>,
}

struct VerifierInner {
    issuer: String,
    authorized_parties: Vec<String>,
    source: Option<HttpSource>,
    cache: Mutex<KeyCache>,
}

struct HttpSource {
    client: reqwest::Client,
    url: String,
}

struct KeyCache {
    jwks: Option<JwkSet>,
    last_refresh: Option<Instant>,
}

impl ClerkVerifier {
    /// Keys are fetched on first verification; construction performs no I/O.
    pub fn new(settings: &ClerkSettings, http: reqwest::Client) -> Self {
        Self {
            inner: Arc::new(VerifierInner {
                issuer: settings.issuer.clone(),
                authorized_parties: settings.authorized_parties.clone(),
                source: Some(HttpSource {
                    client: http,
                    url: settings.jwks_url.clone(),
                }),
                cache: Mutex::new(KeyCache {
                    jwks: None,
                    last_refresh: None,
                }),
            }),
        }
    }

    /// A static verifier never attempts an HTTP fetch, including for unknown keys.
    pub fn from_jwks(
        issuer: impl Into<String>,
        authorized_parties: Vec<String>,
        jwks: JwkSet,
    ) -> Self {
        Self {
            inner: Arc::new(VerifierInner {
                issuer: issuer.into(),
                authorized_parties,
                source: None,
                cache: Mutex::new(KeyCache {
                    jwks: Some(jwks),
                    last_refresh: None,
                }),
            }),
        }
    }

    pub async fn verify(&self, token: &str) -> ApiResult<ClerkClaims> {
        let header = decode_header(token).map_err(|_| ApiError::unauthorized())?;
        if header.alg != Algorithm::RS256 {
            return Err(ApiError::unauthorized());
        }
        let kid = header
            .kid
            .filter(|kid| !kid.is_empty())
            .ok_or_else(ApiError::unauthorized)?;
        let key = self.key(&kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 5;
        validation.validate_nbf = true;
        // Clerk session tokens have no audience contract.
        validation.validate_aud = false;
        validation.set_issuer(&[&self.inner.issuer]);
        validation.set_required_spec_claims(&["exp", "nbf", "iss", "sub"]);
        let claims = decode::<SessionClaims>(token, &key, &validation)
            .map_err(|_| ApiError::unauthorized())?
            .claims;
        if claims.sub.is_empty()
            || claims.sid.is_empty()
            || claims.iss != self.inner.issuer
            || claims.sts.as_deref() == Some("pending")
            || claims.azp.as_ref().is_some_and(|azp| {
                !self.inner.authorized_parties.is_empty()
                    && !self.inner.authorized_parties.contains(azp)
            })
        {
            return Err(ApiError::unauthorized());
        }
        Ok(ClerkClaims {
            user_id: claims.sub,
            session_id: claims.sid,
        })
    }

    async fn key(&self, kid: &str) -> ApiResult<DecodingKey> {
        // Serialize refreshes (including in-flight requests) across every clone.
        // The async mutex permits waiting callers to yield without blocking a thread.
        let mut cache = self.inner.cache.lock().await;
        if cache.jwks.is_none() {
            self.refresh(&mut cache).await?;
            // The initial successful load is separate from an unknown-kid refetch.
            cache.last_refresh = None;
        }
        if let Some(jwk) = cache.jwks.as_ref().and_then(|jwks| jwks.find(kid)) {
            return DecodingKey::from_jwk(jwk).map_err(|_| ApiError::unauthorized());
        }
        self.refresh(&mut cache).await?;
        let jwk = cache
            .jwks
            .as_ref()
            .and_then(|jwks| jwks.find(kid))
            .ok_or_else(ApiError::unauthorized)?;
        DecodingKey::from_jwk(jwk).map_err(|_| ApiError::unauthorized())
    }

    async fn refresh(&self, cache: &mut KeyCache) -> ApiResult<()> {
        let source = self
            .inner
            .source
            .as_ref()
            .ok_or_else(ApiError::unauthorized)?;
        if cache
            .last_refresh
            .is_some_and(|last| last.elapsed() < REFRESH_INTERVAL)
        {
            return Err(ApiError::unauthorized());
        }
        // Record the attempt before awaiting: failures and cancellation are throttled too.
        cache.last_refresh = Some(Instant::now());
        let result = async {
            source
                .client
                .get(&source.url)
                .timeout(Duration::from_secs(10))
                .send()
                .await?
                .error_for_status()?
                .json::<JwkSet>()
                .await
        }
        .await;
        match result {
            Ok(jwks) => {
                cache.jwks = Some(jwks);
                Ok(())
            }
            Err(error) => {
                tracing::warn!(error = %error.without_url(), "Clerk JWKS fetch failed");
                Err(ApiError::unauthorized())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ClerkSettings, Config};
    use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
    use base64::{
        Engine as _,
        engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD},
    };
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, jwk::JwkSet};
    use rsa::{RsaPrivateKey, pkcs8::EncodePrivateKey, rand_core::OsRng, traits::PublicKeyParts};
    use serde_json::{Value, json};
    use std::sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::RwLock;

    const ISSUER: &str = "https://test.clerk.accounts.dev";
    const PARTY: &str = "https://shop.example.com";

    struct TestKey {
        encoding: EncodingKey,
        n: String,
        e: String,
    }

    fn key() -> &'static TestKey {
        static KEY: OnceLock<TestKey> = OnceLock::new();
        KEY.get_or_init(|| {
            let private = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
            let pem = private.to_pkcs8_pem(Default::default()).unwrap();
            TestKey {
                encoding: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
                n: URL_SAFE_NO_PAD.encode(private.n().to_bytes_be()),
                e: URL_SAFE_NO_PAD.encode(private.e().to_bytes_be()),
            }
        })
    }

    fn jwks(kids: &[&str]) -> JwkSet {
        serde_json::from_value(json!({"keys": kids.iter().map(|kid| json!({
            "kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid,
            "n": key().n, "e": key().e,
        })).collect::<Vec<_>>()}))
        .unwrap()
    }

    fn claims() -> Value {
        let now = jsonwebtoken::get_current_timestamp();
        json!({"sub": "user_test", "sid": "sess_test", "iss": ISSUER,
               "exp": now + 600, "nbf": now - 60, "sts": "active"})
    }

    fn token(claims: &Value, kid: Option<&str>) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = kid.map(str::to_owned);
        encode(&header, claims, &key().encoding).unwrap()
    }

    fn verifier() -> ClerkVerifier {
        ClerkVerifier::from_jwks(ISSUER, vec![PARTY.into()], jwks(&["current"]))
    }

    async fn assert_unauthorized(verifier: &ClerkVerifier, token: &str) {
        let error = verifier.verify(token).await.unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.code, "unauthorized");
    }

    #[tokio::test]
    async fn valid_token_returns_identity() {
        let identity = verifier()
            .verify(&token(&claims(), Some("current")))
            .await
            .unwrap();
        assert_eq!(identity.user_id, "user_test");
        assert_eq!(identity.session_id, "sess_test");
    }

    #[tokio::test]
    async fn expired_beyond_leeway_is_rejected() {
        let mut c = claims();
        c["exp"] = json!(jsonwebtoken::get_current_timestamp() - 60);
        assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
    }

    #[tokio::test]
    async fn expired_within_leeway_passes() {
        key(); // Generate RSA before starting the short leeway window.
        let mut c = claims();
        c["exp"] = json!(jsonwebtoken::get_current_timestamp() - 1);
        assert!(verifier().verify(&token(&c, Some("current"))).await.is_ok());
    }

    #[tokio::test]
    async fn future_nbf_beyond_leeway_is_rejected() {
        let mut c = claims();
        c["nbf"] = json!(jsonwebtoken::get_current_timestamp() + 60);
        assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
    }

    #[tokio::test]
    async fn future_nbf_within_leeway_passes() {
        key();
        let mut c = claims();
        c["nbf"] = json!(jsonwebtoken::get_current_timestamp() + 3);
        assert!(verifier().verify(&token(&c, Some("current"))).await.is_ok());
    }

    #[tokio::test]
    async fn wrong_issuer_is_rejected_exactly() {
        for iss in [
            json!("https://other.example.com"),
            json!("https://test.clerk.accounts.dev/"),
            json!([ISSUER]),
        ] {
            let mut c = claims();
            c["iss"] = iss;
            assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
        }
    }

    #[tokio::test]
    async fn unauthorized_party_is_rejected() {
        let mut c = claims();
        c["azp"] = json!("https://other.example.com");
        assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
    }

    #[tokio::test]
    async fn authorized_party_passes() {
        let mut c = claims();
        c["azp"] = json!(PARTY);
        assert!(verifier().verify(&token(&c, Some("current"))).await.is_ok());
    }

    #[tokio::test]
    async fn absent_party_with_configured_parties_passes() {
        assert!(
            verifier()
                .verify(&token(&claims(), Some("current")))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn empty_party_allowlist_and_audience_are_not_validated() {
        let mut c = claims();
        c["azp"] = json!("https://other.example.com");
        c["aud"] = json!("unconfigured-audience");
        let verifier = ClerkVerifier::from_jwks(ISSUER, vec![], jwks(&["current"]));
        assert!(verifier.verify(&token(&c, Some("current"))).await.is_ok());
    }

    #[tokio::test]
    async fn pending_session_is_rejected() {
        let mut c = claims();
        c["sts"] = json!("pending");
        assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
    }

    #[tokio::test]
    async fn required_claims_must_be_present_and_identity_nonempty() {
        for name in ["sub", "sid", "exp", "nbf", "iss"] {
            let mut c = claims();
            c.as_object_mut().unwrap().remove(name);
            assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
        }
        for name in ["sub", "sid"] {
            for value in [json!(""), json!(null), json!(42)] {
                let mut c = claims();
                c[name] = value;
                assert_unauthorized(&verifier(), &token(&c, Some("current"))).await;
            }
        }
    }

    #[tokio::test]
    async fn missing_kid_is_rejected() {
        assert_unauthorized(&verifier(), &token(&claims(), None)).await;
    }

    #[tokio::test]
    async fn hs256_and_other_algorithms_with_same_kid_are_rejected() {
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some("current".into());
        let signed = encode(&header, &claims(), &EncodingKey::from_secret(b"attacker")).unwrap();
        assert_unauthorized(&verifier(), &signed).await;
        header.alg = Algorithm::RS384;
        let signed = encode(&header, &claims(), &key().encoding).unwrap();
        assert_unauthorized(&verifier(), &signed).await;
        let none = format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none","kid":"current"}"#),
            URL_SAFE_NO_PAD.encode(claims().to_string()),
            ""
        );
        assert_unauthorized(&verifier(), &none).await;
    }

    #[tokio::test]
    async fn malformed_token_is_rejected() {
        assert_unauthorized(&verifier(), "not.a.token").await;
    }

    #[tokio::test]
    async fn wrong_signature_and_unknown_static_key_are_rejected() {
        let mut keys = jwks(&["current"]);
        // A different public exponent cannot verify the original signature.
        let mut value = serde_json::to_value(&keys).unwrap();
        value["keys"][0]["e"] = json!("Aw");
        keys = serde_json::from_value(value).unwrap();
        let wrong = ClerkVerifier::from_jwks(ISSUER, vec![], keys);
        assert_unauthorized(&wrong, &token(&claims(), Some("current"))).await;
        assert_unauthorized(&verifier(), &token(&claims(), Some("unknown"))).await;
    }

    #[derive(Clone)]
    struct StubState {
        hits: Arc<AtomicUsize>,
        body: Arc<RwLock<Value>>,
        status: Arc<RwLock<StatusCode>>,
    }
    struct Stub {
        state: StubState,
        settings: ClerkSettings,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Stub {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Stub {
        async fn new() -> Self {
            let state = StubState {
                hits: Arc::new(AtomicUsize::new(0)),
                body: Arc::new(RwLock::new(
                    serde_json::to_value(jwks(&["current"])).unwrap(),
                )),
                status: Arc::new(RwLock::new(StatusCode::OK)),
            };
            let router = Router::new()
                .route(
                    "/jwks",
                    get(|State(state): State<StubState>| async move {
                        state.hits.fetch_add(1, Ordering::SeqCst);
                        (
                            *state.status.read().await,
                            Json(state.body.read().await.clone()),
                        )
                    }),
                )
                .with_state(state.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let settings = ClerkSettings {
                issuer: ISSUER.into(),
                jwks_url: format!("http://{addr}/jwks"),
                api_url: "https://api.clerk.com".into(),
                authorized_parties: vec![],
                secret_key: None,
            };
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                state,
                settings,
                task,
            }
        }
        fn hits(&self) -> usize {
            self.state.hits.load(Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn lazy_loading_and_cached_key_do_not_refetch() {
        let stub = Stub::new().await;
        let verifier = ClerkVerifier::new(&stub.settings, reqwest::Client::new());
        assert_eq!(stub.hits(), 0);
        let signed = token(&claims(), Some("current"));
        for _ in 0..3 {
            assert!(verifier.verify(&signed).await.is_ok());
        }
        assert_eq!(stub.hits(), 1);
    }

    #[tokio::test]
    async fn unknown_key_refetches_once_then_throttles_across_clones() {
        let stub = Stub::new().await;
        let verifier = ClerkVerifier::new(&stub.settings, reqwest::Client::new());
        assert!(
            verifier
                .verify(&token(&claims(), Some("current")))
                .await
                .is_ok()
        );
        assert_eq!(stub.hits(), 1);
        *stub.state.body.write().await =
            serde_json::to_value(jwks(&["current", "rotated"])).unwrap();
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..12 {
            let cloned = verifier.clone();
            let signed = token(&claims(), Some("rotated"));
            requests.spawn(async move { cloned.verify(&signed).await });
        }
        while let Some(result) = requests.join_next().await {
            assert!(result.unwrap().is_ok());
        }
        assert_eq!(stub.hits(), 2);
        for kid in ["unknown-1", "unknown-2"] {
            assert_unauthorized(&verifier.clone(), &token(&claims(), Some(kid))).await;
        }
        assert_eq!(stub.hits(), 2);
    }

    #[tokio::test]
    async fn failed_rotation_preserves_cached_keys() {
        let stub = Stub::new().await;
        let verifier = ClerkVerifier::new(&stub.settings, reqwest::Client::new());
        let signed = token(&claims(), Some("current"));
        assert!(verifier.verify(&signed).await.is_ok());
        *stub.state.status.write().await = StatusCode::SERVICE_UNAVAILABLE;
        assert_unauthorized(&verifier, &token(&claims(), Some("rotated"))).await;
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 2);
    }

    #[tokio::test]
    async fn initial_unknown_key_gets_only_one_refetch() {
        let stub = Stub::new().await;
        let verifier = ClerkVerifier::new(&stub.settings, reqwest::Client::new());
        for _ in 0..3 {
            assert_unauthorized(&verifier, &token(&claims(), Some("unknown"))).await;
        }
        assert_eq!(stub.hits(), 2);
    }

    #[tokio::test]
    async fn failed_jwks_fetches_are_unauthorized_and_throttled() {
        for (status, body) in [
            (StatusCode::SERVICE_UNAVAILABLE, json!({})),
            (StatusCode::OK, json!({"invalid": true})),
        ] {
            let stub = Stub::new().await;
            *stub.state.status.write().await = status;
            *stub.state.body.write().await = body;
            let verifier = ClerkVerifier::new(&stub.settings, reqwest::Client::new());
            for _ in 0..3 {
                assert_unauthorized(&verifier, &token(&claims(), Some("current"))).await;
            }
            assert_eq!(stub.hits(), 1);
        }
        let mut settings = Stub::new().await.settings.clone(); // Server drops immediately.
        settings.jwks_url = "http://127.0.0.1:0/jwks".into();
        assert_unauthorized(
            &ClerkVerifier::new(&settings, reqwest::Client::new()),
            &token(&claims(), Some("current")),
        )
        .await;
    }

    fn settings(values: &[(&str, &str)]) -> anyhow::Result<Option<ClerkSettings>> {
        ClerkSettings::from_lookup(|name| {
            values
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).into())
        })
    }

    #[test]
    fn settings_decode_publishable_keys_with_optional_dollar_and_padding() {
        for prefix in ["pk_test_", "pk_live_"] {
            for host in ["test.clerk.accounts.dev$", "test.clerk.accounts.dev"] {
                for encoded in [STANDARD.encode(host), STANDARD_NO_PAD.encode(host)] {
                    let raw = format!("{prefix}{encoded}");
                    let s = settings(&[("CLERK_PUBLISHABLE_KEY", &raw)])
                        .unwrap()
                        .unwrap();
                    assert_eq!(s.issuer, ISSUER);
                    assert_eq!(s.jwks_url, format!("{ISSUER}/.well-known/jwks.json"));
                    assert_eq!(s.api_url, "https://api.clerk.com");
                    assert!(s.secret_key.is_none());
                }
            }
        }
    }

    #[test]
    fn settings_overrides_and_authorized_parties() {
        let raw = format!("pk_test_{}", STANDARD.encode("host.example$"));
        let s = settings(&[
            ("CLERK_PUBLISHABLE_KEY", &raw),
            ("CLERK_ISSUER", "http://local.test"),
            ("CLERK_JWKS_URL", "http://local.test/keys"),
            ("CLERK_API_URL", "http://local.test/api"),
            (
                "CLERK_AUTHORIZED_PARTIES",
                " https://one.test, ,https://two.test, ",
            ),
            ("CLERK_SECRET_KEY", "sk_test_secret"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(s.issuer, "http://local.test");
        assert_eq!(s.jwks_url, "http://local.test/keys");
        assert_eq!(s.api_url, "http://local.test/api");
        assert_eq!(
            s.authorized_parties,
            ["https://one.test", "https://two.test"]
        );
        assert_eq!(s.secret_key.as_deref(), Some("sk_test_secret"));
        let s = settings(&[("CLERK_ISSUER", ISSUER)]).unwrap().unwrap();
        assert_eq!(s.jwks_url, format!("{ISSUER}/.well-known/jwks.json"));
    }

    #[test]
    fn settings_none_without_key_or_issuer() {
        assert!(settings(&[]).unwrap().is_none());
        assert!(
            settings(&[
                ("CLERK_SECRET_KEY", "sk_test_secret"),
                ("CLERK_JWKS_URL", "http://local/keys")
            ])
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn settings_malformed_publishable_key_is_an_error_even_with_override() {
        for raw in [
            "pk_bad_YQ==",
            "pk_test_!",
            "pk_live_",
            "pk_test_JA==",
            "pk_test_aHR0cHM6Ly9ob3N0",
            "pk_test_aG9zdC9wYXRo",
            "pk_test_aG9zdCAk",
            "pk_test_aG9zdCRleHRyYQ==",
        ] {
            assert!(
                settings(&[("CLERK_PUBLISHABLE_KEY", raw)]).is_err(),
                "{raw}"
            );
            assert!(
                settings(&[("CLERK_PUBLISHABLE_KEY", raw), ("CLERK_ISSUER", ISSUER)]).is_err(),
                "{raw}"
            );
        }
    }

    #[test]
    fn config_requires_clerk_settings_and_ignores_jwt_secret() {
        let cfg = Config::from_lookup(|name| match name {
            "JWT_SECRET" => Some("x".repeat(32)),
            "CLERK_ISSUER" => Some(ISSUER.into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(cfg.clerk.unwrap().issuer, ISSUER);
        let error = Config::from_lookup(|name| (name == "JWT_SECRET").then(|| "x".repeat(32)))
            .err()
            .unwrap();
        assert!(error.to_string().contains("CLERK_PUBLISHABLE_KEY"));
        assert!(error.to_string().contains("CLERK_ISSUER"));
    }
}
