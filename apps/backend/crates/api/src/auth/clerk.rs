//! Clerk session JWT verification, independent of membership and request extraction.
pub use crate::config::ClerkSettings;
use crate::error::{ApiError, ApiResult};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use std::{
    sync::{Arc, PoisonError, RwLock},
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};

/// Timing contract of the JWKS cache; tests inject shorter values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Timing {
    /// A loaded key set older than this is refetched by the next verification.
    max_age: Duration,
    /// Minimum gap between fetch attempts while no key set was ever loaded.
    cold_retry: Duration,
    /// Minimum gap between fetch attempts once a key set is loaded: unknown-`kid`
    /// refetches and retries of a failed expiry refresh.
    refetch_interval: Duration,
    /// Bound on one JWKS request, body included.
    fetch_timeout: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            max_age: Duration::from_secs(60 * 60),
            cold_retry: Duration::from_secs(2),
            refetch_interval: Duration::from_secs(60),
            fetch_timeout: Duration::from_secs(5),
        }
    }
}

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
    timing: Timing,
    /// Lookups clone the `Arc` and release the lock at once, so verifying a known `kid`
    /// never waits on a fetch; only the pointer swap after a fetch takes the write lock.
    keys: RwLock<Option<Arc<KeySet>>>,
    /// Single-flight: whoever holds this lock is the only caller fetching.
    fetch: Mutex<FetchState>,
}

struct HttpSource {
    client: reqwest::Client,
    url: String,
}

struct KeySet {
    jwks: JwkSet,
    loaded_at: Instant,
}

#[derive(Default)]
struct FetchState {
    last_attempt: Option<Instant>,
}

impl ClerkVerifier {
    /// Keys are fetched on first verification; construction performs no I/O.
    pub fn new(settings: &ClerkSettings, http: reqwest::Client) -> Self {
        Self::with_timing(settings, http, Timing::default())
    }

    fn with_timing(settings: &ClerkSettings, http: reqwest::Client, timing: Timing) -> Self {
        Self {
            inner: Arc::new(VerifierInner {
                issuer: settings.issuer.clone(),
                authorized_parties: settings.authorized_parties.clone(),
                source: Some(HttpSource {
                    client: http,
                    url: settings.jwks_url.clone(),
                }),
                timing,
                keys: RwLock::new(None),
                fetch: Mutex::new(FetchState::default()),
            }),
        }
    }

    /// A static verifier never attempts an HTTP fetch, including for unknown keys,
    /// and its keys never expire.
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
                timing: Timing::default(),
                keys: RwLock::new(Some(Arc::new(KeySet {
                    jwks,
                    loaded_at: Instant::now(),
                }))),
                fetch: Mutex::new(FetchState::default()),
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

    fn loaded(&self) -> Option<Arc<KeySet>> {
        self.inner
            .keys
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn expired(&self, set: &KeySet) -> bool {
        self.inner.source.is_some() && set.loaded_at.elapsed() >= self.inner.timing.max_age
    }

    fn lookup(&self, kid: &str) -> Option<ApiResult<DecodingKey>> {
        let set = self.loaded()?;
        let jwk = set.jwks.find(kid)?;
        Some(DecodingKey::from_jwk(jwk).map_err(|_| ApiError::unauthorized()))
    }

    async fn key(&self, kid: &str) -> ApiResult<DecodingKey> {
        if let Some(set) = self.loaded()
            && set.jwks.find(kid).is_some()
        {
            // Expired: exactly one caller revalidates; the others keep verifying with the
            // stale set instead of queueing behind the fetch. A failed refresh keeps it.
            if self.expired(&set)
                && let Ok(mut state) = self.inner.fetch.try_lock()
                && self.loaded().is_some_and(|set| self.expired(&set))
            {
                let _ = self.refetch(&mut state, true).await;
            }
            return self
                .lookup(kid)
                .unwrap_or_else(|| Err(ApiError::unauthorized()));
        }
        // Unknown `kid`, or nothing loaded yet: queue behind the single in-flight fetch.
        let mut state = self.inner.fetch.lock().await;
        if let Some(key) = self.lookup(kid) {
            return key; // Loaded by the fetch this caller waited for.
        }
        if self.loaded().is_none() {
            self.refetch(&mut state, true).await?;
            if let Some(key) = self.lookup(kid) {
                return key;
            }
        }
        self.refetch(&mut state, false).await?;
        self.lookup(kid)
            .unwrap_or_else(|| Err(ApiError::unauthorized()))
    }

    /// Fetch and swap the key set; the caller holds the single-flight lock. A failure
    /// leaves any loaded set in place. `fresh_load` marks a cold or expiry load, which
    /// does not count against the unknown-`kid` throttle.
    async fn refetch(&self, state: &mut FetchState, fresh_load: bool) -> ApiResult<()> {
        let source = self
            .inner
            .source
            .as_ref()
            .ok_or_else(ApiError::unauthorized)?;
        let timing = self.inner.timing;
        // With no key set at all, every request is rejected until a fetch succeeds, so
        // retry soon. Once keys are loaded, throttle so a stream of random `kid`s cannot
        // turn into a stream of fetches.
        let gap = if self.loaded().is_some() {
            timing.refetch_interval
        } else {
            timing.cold_retry
        };
        if state.last_attempt.is_some_and(|last| last.elapsed() < gap) {
            return Err(ApiError::unauthorized());
        }
        // Record the attempt before awaiting: failures and cancellation are throttled too.
        state.last_attempt = Some(Instant::now());
        let fetched = async {
            source
                .client
                .get(&source.url)
                .timeout(timing.fetch_timeout)
                .send()
                .await?
                .error_for_status()?
                .json::<JwkSet>()
                .await
        }
        .await;
        match fetched {
            Ok(jwks) => {
                let set = Arc::new(KeySet {
                    jwks,
                    loaded_at: Instant::now(),
                });
                *self
                    .inner
                    .keys
                    .write()
                    .unwrap_or_else(PoisonError::into_inner) = Some(set);
                if fresh_load {
                    state.last_attempt = None;
                }
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
        delay: Arc<RwLock<Duration>>,
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
                delay: Arc::new(RwLock::new(Duration::ZERO)),
            };
            let router = Router::new()
                .route(
                    "/jwks",
                    get(|State(state): State<StubState>| async move {
                        state.hits.fetch_add(1, Ordering::SeqCst);
                        let delay = *state.delay.read().await;
                        tokio::time::sleep(delay).await;
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
        async fn wait_for_hits(&self, hits: usize) {
            for _ in 0..200 {
                if self.hits() >= hits {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("the stub never reached {hits} requests");
        }
    }

    #[tokio::test]
    async fn known_kid_verification_never_waits_on_a_jwks_fetch() {
        let stub = Stub::new().await;
        let verifier = ClerkVerifier::new(&stub.settings, reqwest::Client::new());
        let known = token(&claims(), Some("current"));
        assert!(verifier.verify(&known).await.is_ok());
        *stub.state.delay.write().await = Duration::from_secs(3);
        let random = token(&claims(), Some("random-kid"));
        let slow = tokio::spawn({
            let verifier = verifier.clone();
            async move { verifier.verify(&random).await }
        });
        stub.wait_for_hits(2).await; // The unknown-kid refetch is now in flight.
        let started = std::time::Instant::now();
        for _ in 0..3 {
            assert!(verifier.verify(&known).await.is_ok());
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "known-kid verification waited for the fetch: {:?}",
            started.elapsed()
        );
        assert_eq!(
            slow.await.unwrap().unwrap_err().status,
            StatusCode::UNAUTHORIZED
        );
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

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }
    fn verifier_with(stub: &Stub, timing: Timing) -> ClerkVerifier {
        ClerkVerifier::with_timing(&stub.settings, reqwest::Client::new(), timing)
    }

    #[test]
    fn timing_defaults_match_the_contract() {
        let timing = Timing::default();
        assert_eq!(timing.max_age, Duration::from_secs(3600));
        assert_eq!(timing.cold_retry, Duration::from_secs(2));
        assert_eq!(timing.refetch_interval, Duration::from_secs(60));
        assert_eq!(timing.fetch_timeout, Duration::from_secs(5));
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
            let timing = Timing {
                cold_retry: ms(1000),
                ..Timing::default()
            };
            let verifier = verifier_with(&stub, timing);
            let signed = token(&claims(), Some("current"));
            for _ in 0..3 {
                assert_unauthorized(&verifier, &signed).await;
            }
            assert_eq!(stub.hits(), 1, "throttled inside the backoff");
        }
        let mut settings = Stub::new().await.settings.clone(); // Server drops immediately.
        settings.jwks_url = "http://127.0.0.1:0/jwks".into();
        assert_unauthorized(
            &ClerkVerifier::new(&settings, reqwest::Client::new()),
            &token(&claims(), Some("current")),
        )
        .await;
    }

    #[tokio::test]
    async fn cold_start_failure_retries_after_a_short_backoff_not_a_minute() {
        let stub = Stub::new().await;
        *stub.state.status.write().await = StatusCode::SERVICE_UNAVAILABLE;
        let timing = Timing {
            cold_retry: ms(300),
            ..Timing::default()
        };
        let verifier = verifier_with(&stub, timing);
        let signed = token(&claims(), Some("current"));
        for _ in 0..3 {
            assert_unauthorized(&verifier, &signed).await;
        }
        assert_eq!(stub.hits(), 1);
        // The upstream recovers; the next verification after the backoff loads the keys.
        *stub.state.status.write().await = StatusCode::OK;
        tokio::time::sleep(ms(350)).await;
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 2);
        // A loaded key set keeps the 60 s unknown-kid throttle.
        assert_unauthorized(&verifier, &token(&claims(), Some("unknown"))).await;
        assert_unauthorized(&verifier, &token(&claims(), Some("unknown"))).await;
        assert_eq!(stub.hits(), 3);
    }

    #[tokio::test]
    async fn expired_key_set_is_refetched_once_across_concurrent_requests() {
        let stub = Stub::new().await;
        let timing = Timing {
            max_age: ms(1000),
            ..Timing::default()
        };
        let verifier = verifier_with(&stub, timing);
        let signed = token(&claims(), Some("current"));
        assert!(verifier.verify(&signed).await.is_ok());
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 1, "a fresh set is not refetched");
        tokio::time::sleep(ms(1050)).await;
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let verifier = verifier.clone();
            let signed = signed.clone();
            requests.spawn(async move { verifier.verify(&signed).await });
        }
        while let Some(result) = requests.join_next().await {
            assert!(result.unwrap().is_ok());
        }
        assert_eq!(stub.hits(), 2, "single-flight refetch after expiry");
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 2, "the refetched set is fresh again");
    }

    #[tokio::test]
    async fn expiry_refetch_replaces_the_key_set() {
        let stub = Stub::new().await;
        let timing = Timing {
            max_age: ms(600),
            ..Timing::default()
        };
        let verifier = verifier_with(&stub, timing);
        let signed = token(&claims(), Some("current"));
        let next = token(&claims(), Some("next"));
        assert!(verifier.verify(&signed).await.is_ok());
        *stub.state.body.write().await = serde_json::to_value(jwks(&["next"])).unwrap();
        tokio::time::sleep(ms(650)).await;
        // The retired key is rejected once the refreshed set no longer carries it.
        assert_unauthorized(&verifier, &signed).await;
        assert!(verifier.verify(&next).await.is_ok());
        assert_eq!(stub.hits(), 2);
    }

    #[tokio::test]
    async fn failed_expiry_refetch_keeps_the_stale_keys_and_throttles() {
        let stub = Stub::new().await;
        let timing = Timing {
            max_age: ms(600),
            refetch_interval: ms(1200),
            ..Timing::default()
        };
        let verifier = verifier_with(&stub, timing);
        let signed = token(&claims(), Some("current"));
        assert!(verifier.verify(&signed).await.is_ok());
        *stub.state.status.write().await = StatusCode::SERVICE_UNAVAILABLE;
        tokio::time::sleep(ms(650)).await;
        assert!(verifier.verify(&signed).await.is_ok(), "stale keys survive");
        assert_eq!(stub.hits(), 2);
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 2, "a failed refresh is not retried at once");
        *stub.state.status.write().await = StatusCode::OK;
        tokio::time::sleep(ms(1250)).await;
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 3, "retried once the interval has passed");
        assert!(verifier.verify(&signed).await.is_ok());
        assert_eq!(stub.hits(), 3, "and the set is fresh again");
    }

    #[tokio::test]
    async fn hanging_jwks_fetch_times_out() {
        let stub = Stub::new().await;
        *stub.state.delay.write().await = Duration::from_secs(5);
        let timing = Timing {
            fetch_timeout: ms(200),
            ..Timing::default()
        };
        let verifier = verifier_with(&stub, timing);
        let started = std::time::Instant::now();
        assert_unauthorized(&verifier, &token(&claims(), Some("current"))).await;
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
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
    fn settings_trim_every_clerk_value() {
        let raw = format!("pk_test_{}", STANDARD.encode("host.example$"));
        let padded = format!(" \t{raw}\r\n");
        let s = settings(&[("CLERK_PUBLISHABLE_KEY", &padded)])
            .unwrap()
            .unwrap();
        assert_eq!(s.issuer, "https://host.example");
        let s = settings(&[
            ("CLERK_PUBLISHABLE_KEY", &padded),
            ("CLERK_ISSUER", "  http://local.test \n"),
            ("CLERK_JWKS_URL", "\thttp://local.test/keys\r\n"),
            ("CLERK_API_URL", " http://local.test/api\n"),
            (
                "CLERK_AUTHORIZED_PARTIES",
                "\n https://one.test ,https://two.test\n",
            ),
            ("CLERK_SECRET_KEY", "sk_test_secret\n"),
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
        let s = settings(&[("CLERK_ISSUER", " http://local.test \n")])
            .unwrap()
            .unwrap();
        assert_eq!(s.jwks_url, "http://local.test/.well-known/jwks.json");
        // Whitespace-only values still count as unset.
        let s = settings(&[("CLERK_ISSUER", ISSUER), ("CLERK_SECRET_KEY", " \n")])
            .unwrap()
            .unwrap();
        assert!(s.secret_key.is_none());
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
