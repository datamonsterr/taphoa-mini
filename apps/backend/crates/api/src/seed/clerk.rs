//! Clerk test users for seeded members, through the Clerk Backend API.
//!
//! Every seeded member gets a deterministic `+clerk_test` email, so the Clerk development
//! instance accepts the fixed verification code `424242` and sends no mail.
//! `GET /v1/users?email_address=` finds an existing user, `POST /v1/users` creates one.
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::time::Duration;
use tokio::{sync::Mutex, time::Instant};

/// Verification code of every Clerk `+clerk_test` identity.
pub const TEST_CODE: &str = "424242";
/// Gap between request starts: at most 4 per second, so 40 per 10 s against the 100 per
/// 10 s budget the development instance shares with both Railway environments, CI and e2e.
pub const DEFAULT_MIN_INTERVAL: Duration = Duration::from_millis(250);
/// Retries after a 429, so one call makes at most six requests per endpoint.
const MAX_RETRIES: u32 = 5;
/// Never sleep longer than this for one `Retry-After`.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);
const DEFAULT_API_URL: &str = "https://api.clerk.com";

/// Email of a seeded member: `seed-<store key>-<member key>+clerk_test@example.com`.
/// Keys are lowercase ASCII letters, digits and hyphens. The eval store uses store key
/// `eval`, so seed and eval members never share a Clerk user.
pub fn member_email(store_key: &str, member_key: &str) -> String {
    format!("seed-{store_key}-{member_key}+clerk_test@example.com")
}

/// Minimal Clerk Backend API users client. Deliberately has no `Debug`: it holds the
/// secret key.
pub struct ClerkUsers {
    http: reqwest::Client,
    base: String,
    secret: String,
    min_interval: Duration,
    next_slot: Mutex<Instant>,
}

#[derive(Deserialize)]
struct UserRef {
    id: String,
}

impl ClerkUsers {
    pub fn new(api_url: &str, secret_key: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: api_url.trim_end_matches('/').to_owned(),
            secret: secret_key.to_owned(),
            min_interval: DEFAULT_MIN_INTERVAL,
            next_slot: Mutex::new(Instant::now()),
        }
    }

    /// `CLERK_SECRET_KEY` (bearer) and `CLERK_API_URL` (default `https://api.clerk.com`).
    /// `None` when the key is unset or empty.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let get = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let secret = get("CLERK_SECRET_KEY")?;
        let api_url = get("CLERK_API_URL").unwrap_or_else(|| DEFAULT_API_URL.into());
        Some(Self::new(&api_url, &secret))
    }

    pub fn from_env() -> Option<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn with_min_interval(mut self, min_interval: Duration) -> Self {
        self.min_interval = min_interval;
        self
    }

    /// The id of the Clerk user with this email: the first match when one exists, else a
    /// newly created passwordless user.
    pub async fn find_or_create(&self, email: &str, first_name: &str) -> Result<String> {
        if let Some(id) = self.find(email).await? {
            return Ok(id);
        }
        let response = self
            .send(|| {
                self.http.post(self.users_url()).json(&serde_json::json!({
                    "email_address": [email],
                    "first_name": first_name,
                    "skip_password_requirement": true,
                }))
            })
            .await
            .with_context(|| format!("create Clerk user {email}"))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response
                .json::<UserRef>()
                .await
                .with_context(|| format!("read created Clerk user {email}"))?
                .id);
        }
        let detail = body_excerpt(response).await;
        // A parallel seed (or another harness) may have created the user since the lookup.
        if let Some(id) = self.find(email).await? {
            return Ok(id);
        }
        bail!("create Clerk user {email}: {status} {detail}")
    }

    async fn find(&self, email: &str) -> Result<Option<String>> {
        let response = self
            .send(|| {
                self.http
                    .get(self.users_url())
                    .query(&[("email_address", email)])
            })
            .await
            .with_context(|| format!("look up Clerk user {email}"))?;
        let status = response.status();
        if !status.is_success() {
            bail!(
                "look up Clerk user {email}: {status} {}",
                body_excerpt(response).await
            );
        }
        let users = response
            .json::<Vec<UserRef>>()
            .await
            .with_context(|| format!("read Clerk users for {email}"))?;
        Ok(users.into_iter().next().map(|user| user.id))
    }

    fn users_url(&self) -> String {
        format!("{}/v1/users", self.base)
    }

    /// Waits for the next request slot, sends, and retries a 429 after its `Retry-After`.
    async fn send(
        &self,
        request: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response> {
        for attempt in 0..=MAX_RETRIES {
            self.pace().await;
            let response = request()
                .bearer_auth(&self.secret)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .context("Clerk request failed")?;
            if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Ok(response);
            }
            if attempt == MAX_RETRIES {
                break;
            }
            let header = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok());
            tokio::time::sleep(retry_delay(header, attempt + 1)).await;
        }
        bail!("Clerk rate limit (429) persisted after {MAX_RETRIES} retries")
    }

    async fn pace(&self) {
        let mut next = self.next_slot.lock().await;
        tokio::time::sleep_until(*next).await;
        *next = Instant::now() + self.min_interval;
    }
}

/// `Retry-After` in seconds (decimals allowed), capped; otherwise `attempt` seconds.
fn retry_delay(header: Option<&str>, attempt: u32) -> Duration {
    header
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map_or_else(
            || Duration::from_secs(u64::from(attempt)),
            |seconds| Duration::from_secs_f64(seconds.min(MAX_RETRY_DELAY.as_secs_f64())),
        )
        .min(MAX_RETRY_DELAY)
}

/// Clerk error bodies are JSON without secrets. Keep the log line short anyway.
async fn body_excerpt(response: reqwest::Response) -> String {
    let text = response.text().await.unwrap_or_default();
    text.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::super::{MEMBERS, Store};
    use super::*;
    use chrono::{NaiveDate, Utc};
    use std::collections::HashSet;

    fn seed_emails() -> Vec<String> {
        (1..=2)
            .flat_map(|number| {
                let store = Store {
                    number,
                    today: NaiveDate::from_ymd_opt(2026, 10, 23).unwrap(),
                    now: Utc::now(),
                };
                store
                    .report()
                    .members
                    .into_iter()
                    .map(|member| member.email)
            })
            .collect()
    }

    #[test]
    fn member_email_uses_store_and_member_keys_with_the_clerk_test_subaddress() {
        assert_eq!(
            member_email("coba", "me"),
            "seed-coba-me+clerk_test@example.com"
        );
        assert_eq!(
            member_email("eval", "lead"),
            "seed-eval-lead+clerk_test@example.com"
        );
    }

    #[test]
    fn every_seeded_member_has_a_distinct_deterministic_clerk_test_email() {
        let emails = seed_emails();
        assert_eq!(emails.len(), 2 * MEMBERS.len());
        assert_eq!(emails, seed_emails(), "emails depend on nothing but keys");
        assert_eq!(emails.iter().collect::<HashSet<_>>().len(), emails.len());
        for email in &emails {
            let local = email.strip_suffix("+clerk_test@example.com").unwrap();
            assert!(local.starts_with("seed-"), "{email}");
            assert!(
                local
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{email}"
            );
        }
        assert!(emails.contains(&"seed-coba-me+clerk_test@example.com".to_owned()));
        assert!(emails.contains(&"seed-minhkhai-co-lan+clerk_test@example.com".to_owned()));
    }

    #[test]
    fn retry_after_is_honoured_and_capped() {
        assert_eq!(retry_delay(Some("0"), 1), Duration::ZERO);
        assert_eq!(retry_delay(Some(" 3 "), 1), Duration::from_secs(3));
        assert_eq!(retry_delay(Some("0.5"), 1), Duration::from_millis(500));
        assert_eq!(retry_delay(Some("86400"), 1), MAX_RETRY_DELAY);
        assert_eq!(retry_delay(Some("inf"), 2), Duration::from_secs(2));
        assert_eq!(retry_delay(Some("-4"), 3), Duration::from_secs(3));
        assert_eq!(retry_delay(Some("soon"), 4), Duration::from_secs(4));
        assert_eq!(retry_delay(None, 5), Duration::from_secs(5));
    }

    #[test]
    fn default_pacing_stays_well_under_the_dev_instance_budget() {
        let per_ten_seconds = 10_000 / DEFAULT_MIN_INTERVAL.as_millis();
        assert!(per_ten_seconds <= 50, "{per_ten_seconds} requests per 10 s");
    }

    #[test]
    fn client_needs_a_secret_key_and_defaults_the_api_url() {
        let none = |_: &str| None;
        assert!(ClerkUsers::from_lookup(none).is_none());
        let empty = |name: &str| (name == "CLERK_SECRET_KEY").then(|| "  ".to_owned());
        assert!(ClerkUsers::from_lookup(empty).is_none());
        let keyed = |name: &str| (name == "CLERK_SECRET_KEY").then(|| "sk_test_x".to_owned());
        let client = ClerkUsers::from_lookup(keyed).unwrap();
        assert_eq!(client.users_url(), "https://api.clerk.com/v1/users");
        let custom = |name: &str| match name {
            "CLERK_SECRET_KEY" => Some("sk_test_x".to_owned()),
            "CLERK_API_URL" => Some("http://127.0.0.1:9/".to_owned()),
            _ => None,
        };
        let client = ClerkUsers::from_lookup(custom).unwrap();
        assert_eq!(client.users_url(), "http://127.0.0.1:9/v1/users");
    }
}
