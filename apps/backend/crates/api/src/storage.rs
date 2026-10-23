//! Private S3-compatible objects. Only object keys are persisted by the API.
use anyhow::{Context, bail};
use async_trait::async_trait;
use aws_config::{BehaviorVersion, timeout::TimeoutConfig};
use aws_sdk_s3::{
    Client,
    config::{Credentials, Region},
    presigning::PresigningConfig,
    primitives::ByteStream,
};
use chrono::{DateTime, Utc};
use std::time::{Duration, SystemTime};

pub struct SignedUrl {
    pub url: String,
    pub expires_at: DateTime<Utc>,
}

#[async_trait]
pub trait ObjectStore: Send + Sync {
    async fn put(&self, key: &str, content_type: &str, bytes: Vec<u8>) -> anyhow::Result<()>;
    async fn delete(&self, key: &str) -> anyhow::Result<()>;
    async fn head_bucket(&self) -> anyhow::Result<()>;
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl>;
    /// Read an object (catalog embeds stored photos). Fakes may leave the default.
    async fn get(&self, _key: &str) -> anyhow::Result<Vec<u8>> {
        anyhow::bail!("object reads are not supported by this store")
    }
}

// Deliberately no Debug: credentials must never appear in configuration logs.
pub struct StorageConfig {
    endpoint: String,
    public_endpoint: Option<String>,
    access_key: String,
    secret_key: String,
    bucket: String,
    region: String,
    force_path_style: bool,
    pub create_bucket: bool,
    pub url_ttl: Duration,
}
impl StorageConfig {
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        Self::parse(|name| std::env::var(name).ok())
    }

    fn parse(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Option<Self>> {
        let names = [
            "AWS_ENDPOINT_URL",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_S3_BUCKET_NAME",
            "AWS_DEFAULT_REGION",
        ];
        let values: Vec<_> = names.iter().map(|name| get(name)).collect();
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        for (name, value) in names.iter().zip(&values) {
            if value.as_ref().is_none_or(|value| value.trim().is_empty()) {
                bail!("set all five AWS_* storage variables; {name} is missing or empty");
            }
        }
        let boolean = |name| -> anyhow::Result<bool> {
            get(name).map_or(Ok(false), |value| {
                value
                    .parse()
                    .with_context(|| format!("{name} must be true or false"))
            })
        };
        let ttl: u64 = get("IMAGE_URL_TTL_SECONDS")
            .unwrap_or_else(|| "900".into())
            .parse()
            .context("IMAGE_URL_TTL_SECONDS must be an integer")?;
        if !(1..=604800).contains(&ttl) {
            bail!("IMAGE_URL_TTL_SECONDS must be between 1 and 604800 (S3 maximum)");
        }
        let required = |index: usize| values[index].clone().expect("validated required variable");
        let endpoint = required(0);
        let public_endpoint = get("S3_PUBLIC_ENDPOINT_URL");
        for url in std::iter::once(&endpoint).chain(public_endpoint.iter()) {
            let uri: axum::http::Uri = url.parse().context("S3 endpoint must be an HTTP(S) URL")?;
            if !matches!(uri.scheme_str(), Some("http" | "https")) || uri.host().is_none() {
                bail!("S3 endpoint must be an HTTP(S) URL");
            }
        }
        Ok(Some(Self {
            endpoint,
            public_endpoint,
            access_key: required(1),
            secret_key: required(2),
            bucket: required(3),
            region: required(4),
            force_path_style: boolean("S3_FORCE_PATH_STYLE")?,
            create_bucket: boolean("S3_CREATE_BUCKET")?,
            url_ttl: Duration::from_secs(ttl),
        }))
    }
}

pub struct S3Store {
    client: Client,
    signing_client: Client,
    bucket: String,
}
impl S3Store {
    pub async fn new(config: &StorageConfig) -> Self {
        let shared = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(config.region.clone()))
            .credentials_provider(Credentials::new(
                &config.access_key,
                &config.secret_key,
                None,
                None,
                "storage-env",
            ))
            .timeout_config(
                TimeoutConfig::builder()
                    .operation_timeout(Duration::from_secs(30))
                    .build(),
            )
            .load()
            .await;
        let builder =
            aws_sdk_s3::config::Builder::from(&shared).force_path_style(config.force_path_style);
        let client = Client::from_conf(builder.clone().endpoint_url(&config.endpoint).build());
        // Sign the actual public host; rewriting a URL after signing breaks SigV4.
        let signing_client = Client::from_conf(
            builder
                .endpoint_url(config.public_endpoint.as_ref().unwrap_or(&config.endpoint))
                .build(),
        );
        Self {
            client,
            signing_client,
            bucket: config.bucket.clone(),
        }
    }

    pub async fn ensure_bucket(&self) -> anyhow::Result<()> {
        match self.client.head_bucket().bucket(&self.bucket).send().await {
            Ok(_) => Ok(()),
            Err(error)
                if error
                    .raw_response()
                    .is_some_and(|response| response.status().as_u16() == 404) =>
            {
                match self
                    .client
                    .create_bucket()
                    .bucket(&self.bucket)
                    .send()
                    .await
                {
                    Ok(_) => Ok(()),
                    // Concurrent API starts may both observe a missing bucket.
                    Err(error)
                        if error
                            .as_service_error()
                            .is_some_and(|error| error.is_bucket_already_owned_by_you()) =>
                    {
                        Ok(())
                    }
                    Err(error) => Err(error.into()),
                }
            }
            Err(error) => Err(error.into()),
        }
    }
}
#[async_trait]
impl ObjectStore for S3Store {
    async fn put(&self, key: &str, content_type: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(content_type)
            .body(ByteStream::from(bytes))
            .send()
            .await?;
        Ok(())
    }
    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        let object = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await?;
        Ok(object.body.collect().await?.into_bytes().to_vec())
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await?;
        Ok(())
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        self.client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await?;
        Ok(())
    }
    async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
        let start = SystemTime::now();
        let presigning = PresigningConfig::builder()
            .start_time(start)
            .expires_in(ttl)
            .build()?;
        let signed = self
            .signing_client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .presigned(presigning)
            .await?;
        Ok(SignedUrl {
            url: signed.uri().to_owned(),
            expires_at: (start + ttl).into(),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    #[derive(Default)]
    pub struct FakeStore {
        pub objects: Mutex<HashMap<String, Vec<u8>>>,
        pub deleted: Mutex<Vec<String>>,
        pub fail: AtomicBool,
    }
    #[async_trait]
    impl ObjectStore for FakeStore {
        async fn put(&self, key: &str, _: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
            self.head_bucket().await?;
            self.objects.lock().unwrap().insert(key.into(), bytes);
            Ok(())
        }
        async fn delete(&self, key: &str) -> anyhow::Result<()> {
            self.objects.lock().unwrap().remove(key);
            self.deleted.lock().unwrap().push(key.into());
            Ok(())
        }
        async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
            self.head_bucket().await?;
            self.objects
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("object {key} not found"))
        }
        async fn head_bucket(&self) -> anyhow::Result<()> {
            if self.fail.load(Ordering::Relaxed) {
                bail!("fake storage failure");
            }
            Ok(())
        }
        async fn presign_get(&self, key: &str, ttl: Duration) -> anyhow::Result<SignedUrl> {
            self.head_bucket().await?;
            Ok(SignedUrl {
                url: format!("https://fake.test/{key}?signed={}", uuid::Uuid::new_v4()),
                expires_at: (SystemTime::now() + ttl).into(),
            })
        }
    }
    #[tokio::test]
    async fn presigns_the_public_endpoint_with_configured_expiry() {
        let config = StorageConfig::parse(|name| match name {
            "AWS_ENDPOINT_URL" => Some("http://storage:9000".into()),
            "S3_PUBLIC_ENDPOINT_URL" => Some("http://localhost:19000".into()),
            "S3_FORCE_PATH_STYLE" => Some("true".into()),
            "IMAGE_URL_TTL_SECONDS" => Some("60".into()),
            name if name.starts_with("AWS_") => Some("test".into()),
            _ => None,
        })
        .unwrap()
        .unwrap();
        let store = S3Store::new(&config).await;
        let before = Utc::now();
        let signed = store
            .presign_get("images/2026/10/test.png", config.url_ttl)
            .await
            .unwrap();
        assert!(
            signed
                .url
                .starts_with("http://localhost:19000/test/images/2026/10/test.png?")
        );
        assert!(signed.url.contains("X-Amz-Expires=60"));
        assert!(signed.url.contains("X-Amz-Signature="));
        assert!((signed.expires_at - before).num_seconds() >= 60);
        assert!((signed.expires_at - Utc::now()).num_seconds() <= 60);
    }
    #[test]
    fn configuration_is_all_or_nothing_and_validated() {
        assert!(StorageConfig::parse(|_| None).unwrap().is_none());
        assert!(
            StorageConfig::parse(|name| (name == "AWS_ACCESS_KEY_ID").then(|| "test".into()))
                .is_err()
        );
        let get = |name: &str| match name {
            "AWS_ENDPOINT_URL" => Some("http://localhost:9000".into()),
            name if name.starts_with("AWS_") => Some("test".into()),
            _ => None,
        };
        let config = StorageConfig::parse(get).unwrap().unwrap();
        assert_eq!(config.url_ttl, Duration::from_secs(900));
        assert!(!config.create_bucket);
        for (name, value) in [
            ("IMAGE_URL_TTL_SECONDS", "0"),
            ("IMAGE_URL_TTL_SECONDS", "604801"),
            ("S3_FORCE_PATH_STYLE", "yes"),
            ("S3_CREATE_BUCKET", "yes"),
            ("AWS_SECRET_ACCESS_KEY", ""),
            ("AWS_ENDPOINT_URL", "invalid"),
            ("S3_PUBLIC_ENDPOINT_URL", "invalid"),
        ] {
            assert!(
                StorageConfig::parse(|key| if key == name {
                    Some(value.into())
                } else {
                    get(key)
                })
                .is_err(),
                "{name}={value}"
            );
        }
    }
}
