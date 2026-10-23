use anyhow::{Context, bail};
use std::{path::PathBuf, sync::Arc};
use taphoa_recognition::{SamOptions, SamSegmenter, Segmenter};

// No Debug: contains the signing secret.
#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: Option<String>,
    pub redis_url: Option<String>,
    pub encoder: Option<PathBuf>,
    pub decoder: Option<PathBuf>,
    pub jwt_secret: String,
    pub db_max_connections: u32,
}
impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let jwt_secret = get("JWT_SECRET").context("JWT_SECRET is required (at least 32 bytes)")?;
        if jwt_secret.len() < 32 {
            bail!("JWT_SECRET must be at least 32 bytes");
        }
        let db_max_connections = get("DB_MAX_CONNECTIONS")
            .unwrap_or_else(|| "10".into())
            .parse()
            .context("DB_MAX_CONNECTIONS must be a positive integer")?;
        if db_max_connections == 0 {
            bail!("DB_MAX_CONNECTIONS must be a positive integer");
        }
        Ok(Self {
            port: get("PORT")
                .unwrap_or_else(|| "8080".into())
                .parse()
                .context("PORT must be a u16")?,
            database_url: get("DATABASE_URL"),
            redis_url: get("REDIS_URL"),
            encoder: get("SAM_ENCODER_PATH").map(PathBuf::from),
            decoder: get("SAM_DECODER_PATH").map(PathBuf::from),
            jwt_secret,
            db_max_connections,
        })
    }
    pub fn segmenter(&self) -> anyhow::Result<Option<Arc<dyn Segmenter>>> {
        match (&self.encoder, &self.decoder) {
            (None, None) => Ok(None),
            (Some(encoder), Some(decoder)) if !encoder.exists() && !decoder.exists() => {
                tracing::warn!("SAM weights absent; segmentation is unavailable");
                Ok(None)
            }
            (Some(encoder), Some(decoder)) => Ok(Some(Arc::new(SamSegmenter::load(
                encoder,
                decoder,
                SamOptions::from_env(),
            )?))),
            _ => bail!("set both SAM_ENCODER_PATH and SAM_DECODER_PATH, or neither"),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_without_exposing_secret() {
        assert!(
            Config::from_lookup(|_| None)
                .err()
                .unwrap()
                .to_string()
                .contains("JWT_SECRET")
        );
        let secret = "private-short-value";
        let error = Config::from_lookup(|_| Some(secret.into()))
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains(secret));
        let defaults =
            Config::from_lookup(|name| (name == "JWT_SECRET").then(|| "x".repeat(32))).unwrap();
        assert_eq!(defaults.port, 8080);
        assert_eq!(defaults.db_max_connections, 10);
        assert!(defaults.segmenter().unwrap().is_none());
        for (key, value) in [
            ("PORT", "65536"),
            ("DB_MAX_CONNECTIONS", "0"),
            ("DB_MAX_CONNECTIONS", "bad"),
        ] {
            assert!(
                Config::from_lookup(|name| match name {
                    "JWT_SECRET" => Some("x".repeat(32)),
                    name if name == key => Some(value.into()),
                    _ => None,
                })
                .is_err()
            );
        }
    }
    #[test]
    fn reads_service_and_model_settings() {
        let config = Config::from_lookup(|name| {
            Some(match name {
                "JWT_SECRET" => "x".repeat(32),
                "PORT" => "9000".into(),
                "DB_MAX_CONNECTIONS" => "24".into(),
                _ => name.into(),
            })
        })
        .unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(config.db_max_connections, 24);
        assert_eq!(config.database_url.as_deref(), Some("DATABASE_URL"));
        assert_eq!(config.redis_url.as_deref(), Some("REDIS_URL"));
        assert_eq!(config.encoder, Some(PathBuf::from("SAM_ENCODER_PATH")));
        assert_eq!(config.decoder, Some(PathBuf::from("SAM_DECODER_PATH")));
    }
}
