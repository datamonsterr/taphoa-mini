//! Best-effort Clerk profile reads. Identity and membership never depend on this service.
use crate::config::ClerkSettings;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

/// How long a failed Clerk read is remembered. The Backend API budget (100 requests per
/// 10 s) is shared by every holder of the secret key, so an outage, a revoked secret or a
/// 429 must not turn every `GET /v1/me` into another Clerk call.
const FAILURE_TTL: Duration = Duration::from_secs(60);
/// Upper bound on failures remembered in memory by one instance.
const MAX_REMEMBERED_FAILURES: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub display_name: Option<String>,
    pub email: Option<String>,
}
#[derive(Clone)]
pub struct ProfileClient {
    // No Debug: contains a secret key. Disabled in service-free defaults and tests.
    settings: Option<ClerkSettings>,
    client: reqwest::Client,
    failure_ttl: Duration,
    /// Failures this instance saw, by user id. Covers a missing or failing Redis; with
    /// Redis, the shared marker also spares the other instances.
    failures: Arc<Mutex<HashMap<String, Instant>>>,
}
impl Default for ProfileClient {
    fn default() -> Self {
        Self {
            settings: None,
            client: crate::http_client(),
            failure_ttl: FAILURE_TTL,
            failures: Arc::default(),
        }
    }
}
#[derive(Deserialize)]
struct User {
    first_name: Option<String>,
    last_name: Option<String>,
    username: Option<String>,
    primary_email_address_id: Option<String>,
    email_addresses: Vec<EmailAddress>,
}
#[derive(Deserialize)]
struct EmailAddress {
    id: String,
    email_address: String,
}
/// Why a Clerk read failed: only the status code or a fixed word, never anything about the user.
enum Failure {
    Status(u16),
    Other(&'static str),
}
impl ProfileClient {
    pub fn new(settings: &ClerkSettings, client: reqwest::Client) -> Self {
        Self {
            settings: Some(settings.clone()),
            client,
            ..Self::default()
        }
    }
    /// Shorten (tests) how long a failed read is remembered.
    pub fn with_failure_ttl(mut self, ttl: Duration) -> Self {
        self.failure_ttl = ttl;
        self
    }
    pub async fn get(&self, user_id: &str, redis: Option<&ConnectionManager>) -> Option<Profile> {
        let settings = self.settings.as_ref()?;
        let secret = settings.secret_key.as_ref().filter(|key| !key.is_empty())?;
        let key = format!("clerk:user:{user_id}");
        // Distinct from the success key, so a failure can never be read as a profile.
        let failure_key = format!("clerk:user-fail:{user_id}");
        if let Some(mut redis) = redis.cloned() {
            if let Ok(Some(cached)) = redis::cmd("GET")
                .arg(&key)
                .query_async::<Option<String>>(&mut redis)
                .await
                && let Ok(profile) = serde_json::from_str(&cached)
            {
                return Some(profile);
            }
            if let Ok(Some(_)) = redis::cmd("GET")
                .arg(&failure_key)
                .query_async::<Option<String>>(&mut redis)
                .await
            {
                return None;
            }
        }
        if self.recently_failed(user_id) {
            return None;
        }
        let profile = match self.fetch(&settings.api_url, secret, user_id).await {
            Ok(profile) => profile,
            Err(failure) => {
                match failure {
                    Failure::Status(status) => tracing::warn!(status, "Clerk profile fetch failed"),
                    Failure::Other(reason) => tracing::warn!(reason, "Clerk profile fetch failed"),
                }
                self.remember_failure(user_id);
                if let Some(mut redis) = redis.cloned() {
                    let _: Result<(), _> = redis::cmd("SET")
                        .arg(&failure_key)
                        .arg(1)
                        .arg("PX")
                        .arg(self.failure_ttl.as_millis().max(1) as u64)
                        .query_async(&mut redis)
                        .await;
                }
                return None;
            }
        };
        if let Some(mut redis) = redis.cloned()
            && let Ok(value) = serde_json::to_string(&profile)
        {
            let _: Result<(), _> = redis::cmd("SETEX")
                .arg(&key)
                .arg(600)
                .arg(value)
                .query_async(&mut redis)
                .await;
        }
        Some(profile)
    }

    async fn fetch(&self, api_url: &str, secret: &str, user_id: &str) -> Result<Profile, Failure> {
        let mut url = reqwest::Url::parse(&format!("{}/v1/users/", api_url.trim_end_matches('/')))
            .map_err(|_| Failure::Other("url"))?;
        url.path_segments_mut()
            .map_err(|()| Failure::Other("url"))?
            .pop_if_empty()
            .push(user_id);
        // reqwest errors print the URL, which carries the user id: classify, never print.
        let response = self
            .client
            .get(url)
            .bearer_auth(secret)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .map_err(|error| {
                Failure::Other(if error.is_timeout() {
                    "timeout"
                } else if error.is_connect() {
                    "connect"
                } else {
                    "request"
                })
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(Failure::Status(status.as_u16()));
        }
        let user = response
            .json::<User>()
            .await
            .map_err(|_| Failure::Other("decode"))?;
        let name = [
            user.first_name.as_deref().unwrap_or("").trim(),
            user.last_name.as_deref().unwrap_or("").trim(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        let display_name = if name.is_empty() {
            user.username
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
        } else {
            Some(name)
        };
        let email = user.primary_email_address_id.and_then(|id| {
            user.email_addresses
                .into_iter()
                .find(|email| email.id == id)
                .map(|email| email.email_address)
        });
        Ok(Profile {
            display_name,
            email,
        })
    }

    fn recently_failed(&self, user_id: &str) -> bool {
        let failures = self.failures.lock().unwrap_or_else(PoisonError::into_inner);
        failures
            .get(user_id)
            .is_some_and(|until| *until > Instant::now())
    }

    fn remember_failure(&self, user_id: &str) {
        let now = Instant::now();
        let mut failures = self.failures.lock().unwrap_or_else(PoisonError::into_inner);
        if failures.len() >= MAX_REMEMBERED_FAILURES {
            failures.retain(|_, until| *until > now);
        }
        if failures.len() < MAX_REMEMBERED_FAILURES || failures.contains_key(user_id) {
            failures.insert(user_id.to_owned(), now + self.failure_ttl);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
    use serde_json::{Value, json};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    const SECRET: &str = "sk_test_never_logged";
    const USER: &str = "user_2abcSECRETid";

    #[derive(Clone)]
    struct Clerk {
        calls: Arc<AtomicUsize>,
        reply: Arc<Mutex<(StatusCode, Value)>>,
    }
    struct Stub {
        clerk: Clerk,
        client: ProfileClient,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Stub {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Stub {
        async fn new(status: StatusCode, body: Value) -> Self {
            let clerk = Clerk {
                calls: Arc::new(AtomicUsize::new(0)),
                reply: Arc::new(Mutex::new((status, body))),
            };
            let router = Router::new()
                .route(
                    "/v1/users/{id}",
                    get(|State(clerk): State<Clerk>| async move {
                        clerk.calls.fetch_add(1, Ordering::SeqCst);
                        let (status, body) = clerk.reply.lock().unwrap().clone();
                        (status, Json(body))
                    }),
                )
                .with_state(clerk.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let api_url = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                clerk,
                client: client(&api_url),
                task,
            }
        }
        fn calls(&self) -> usize {
            self.clerk.calls.load(Ordering::SeqCst)
        }
        fn reply(&self, status: StatusCode, body: Value) {
            *self.clerk.reply.lock().unwrap() = (status, body);
        }
    }
    fn client(api_url: &str) -> ProfileClient {
        ProfileClient::new(
            &ClerkSettings {
                issuer: "unused".into(),
                jwks_url: "unused".into(),
                api_url: api_url.into(),
                authorized_parties: vec![],
                secret_key: Some(SECRET.into()),
            },
            crate::http_client(),
        )
    }
    fn user() -> Value {
        json!({"first_name":"Lan","last_name":null,"username":null,
               "primary_email_address_id":"e1",
               "email_addresses":[{"id":"e1","email_address":"lan@example.com"}]})
    }

    /// Collects formatted tracing output of the current thread.
    /// Run these tests one at a time: the tracing callsites they share misbehave when a
    /// log-capturing test runs next to the others (it passes alone and under nextest).
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[derive(Clone, Default)]
    struct Logs(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Logs {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Logs {
        fn capture(&self) -> tracing::subscriber::DefaultGuard {
            let sink = self.clone();
            tracing::subscriber::set_default(
                tracing_subscriber::fmt()
                    .with_writer(move || sink.clone())
                    .with_ansi(false)
                    .with_max_level(tracing::Level::WARN)
                    .finish(),
            )
        }
        fn lines(&self) -> Vec<String> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    #[tokio::test]
    async fn clerk_failures_are_remembered_for_a_while_without_redis() {
        let _serial = SERIAL.lock().await;
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let stub = Stub::new(status, json!({"errors": []})).await;
            for _ in 0..3 {
                assert_eq!(stub.client.get(USER, None).await, None, "{status}");
            }
            assert_eq!(stub.calls(), 1, "{status}: one Clerk call, then the cache");
            // Another user is not affected by it.
            assert_eq!(stub.client.get("user_other", None).await, None);
            assert_eq!(stub.calls(), 2);
        }
    }

    #[tokio::test]
    async fn transport_and_decode_failures_are_remembered_too() {
        let _serial = SERIAL.lock().await;
        let stub = Stub::new(StatusCode::OK, json!({"unexpected": true})).await;
        for _ in 0..3 {
            assert_eq!(stub.client.get(USER, None).await, None);
        }
        assert_eq!(stub.calls(), 1, "an undecodable body counts as a failure");
        // Nothing listens on port 1.
        let unreachable = client("http://127.0.0.1:1");
        assert_eq!(unreachable.get(USER, None).await, None);
        assert!(
            unreachable.failures.lock().unwrap().contains_key(USER),
            "a connection error is remembered"
        );
    }

    #[tokio::test]
    async fn remembered_failures_expire() {
        let _serial = SERIAL.lock().await;
        let stub = Stub::new(StatusCode::BAD_GATEWAY, json!({})).await;
        let client = stub
            .client
            .clone()
            .with_failure_ttl(Duration::from_millis(300));
        assert_eq!(client.get(USER, None).await, None);
        assert_eq!(client.get(USER, None).await, None);
        assert_eq!(stub.calls(), 1);
        stub.reply(StatusCode::OK, user());
        tokio::time::sleep(Duration::from_millis(350)).await;
        let profile = client.get(USER, None).await.expect("Clerk recovered");
        assert_eq!(profile.display_name.as_deref(), Some("Lan"));
        assert_eq!(profile.email.as_deref(), Some("lan@example.com"));
        assert_eq!(stub.calls(), 2);
    }

    #[tokio::test]
    async fn the_failure_cache_stays_bounded() {
        let _serial = SERIAL.lock().await;
        let client = client("http://127.0.0.1:1").with_failure_ttl(Duration::from_secs(60));
        for n in 0..(MAX_REMEMBERED_FAILURES + 50) {
            client.get(&format!("user_{n}"), None).await;
        }
        assert!(client.failures.lock().unwrap().len() <= MAX_REMEMBERED_FAILURES);
    }

    #[tokio::test]
    async fn a_failure_logs_one_warning_with_the_status_and_nothing_identifying() {
        let _serial = SERIAL.lock().await;
        let logs = Logs::default();
        let _guard = logs.capture();
        let stub = Stub::new(StatusCode::UNAUTHORIZED, json!({"errors": []})).await;
        for _ in 0..3 {
            stub.client.get(USER, None).await;
        }
        let lines = logs.lines();
        assert_eq!(lines.len(), 1, "one warning per failed fetch: {lines:?}");
        assert!(lines[0].contains("WARN"), "{lines:?}");
        assert!(lines[0].contains("401"), "{lines:?}");
        for secret in [USER, SECRET, "lan@example.com", "127.0.0.1"] {
            assert!(!lines[0].contains(secret), "{secret} leaked: {lines:?}");
        }
        // A transport failure warns once as well, without the URL (which carries the id).
        let unreachable = client("http://127.0.0.1:1");
        unreachable.get(USER, None).await;
        unreachable.get(USER, None).await;
        let lines = logs.lines();
        assert_eq!(lines.len(), 2, "{lines:?}");
        for secret in [USER, SECRET] {
            assert!(!lines[1].contains(secret), "{secret} leaked: {lines:?}");
        }
    }
}
