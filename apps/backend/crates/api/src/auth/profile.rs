//! Best-effort Clerk profile reads. Identity and membership never depend on this service.
use crate::config::ClerkSettings;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub display_name: Option<String>,
    pub email: Option<String>,
}
#[derive(Clone, Default)]
pub struct ProfileClient {
    // No Debug: contains a secret key. Disabled in service-free defaults and tests.
    settings: Option<ClerkSettings>,
    client: reqwest::Client,
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
impl ProfileClient {
    pub fn new(settings: &ClerkSettings, client: reqwest::Client) -> Self {
        Self {
            settings: Some(settings.clone()),
            client,
        }
    }
    pub async fn get(&self, user_id: &str, redis: Option<&ConnectionManager>) -> Option<Profile> {
        let settings = self.settings.as_ref()?;
        let secret = settings.secret_key.as_ref().filter(|key| !key.is_empty())?;
        let key = format!("clerk:user:{user_id}");
        if let Some(mut redis) = redis.cloned()
            && let Ok(Some(cached)) = redis::cmd("GET")
                .arg(&key)
                .query_async::<Option<String>>(&mut redis)
                .await
            && let Ok(profile) = serde_json::from_str(&cached)
        {
            return Some(profile);
        }
        let mut url = reqwest::Url::parse(&format!(
            "{}/v1/users/",
            settings.api_url.trim_end_matches('/')
        ))
        .ok()?;
        url.path_segments_mut().ok()?.pop_if_empty().push(user_id);
        let user = self
            .client
            .get(url)
            .bearer_auth(secret)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json::<User>()
            .await
            .ok()?;
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
        let profile = Profile {
            display_name,
            email,
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
}
