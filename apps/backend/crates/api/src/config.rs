use crate::ratelimit::{ClientIpSource, RateLimits};
use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD_INDIFFERENT};
use std::{path::PathBuf, sync::Arc};
use taphoa_recognition::ocr::{PpOcrDetector, VietOcr};
use taphoa_recognition::{DinoEmbedder, Embedder, SamOptions, SamSegmenter, Segmenter};

// No Debug: contains the optional Clerk secret key.
#[derive(Clone)]
pub struct ClerkSettings {
    pub issuer: String,
    pub jwks_url: String,
    pub api_url: String,
    pub authorized_parties: Vec<String>,
    pub secret_key: Option<String>,
}
impl ClerkSettings {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Option<Self>> {
        let derived_issuer = get("CLERK_PUBLISHABLE_KEY")
            .map(|key| -> anyhow::Result<String> {
                let encoded = key
                    .strip_prefix("pk_test_")
                    .or_else(|| key.strip_prefix("pk_live_"))
                    .context("CLERK_PUBLISHABLE_KEY must start with pk_test_ or pk_live_")?;
                let decoded = STANDARD_NO_PAD_INDIFFERENT
                    .decode(encoded)
                    .context("CLERK_PUBLISHABLE_KEY must contain standard base64")?;
                let decoded = String::from_utf8(decoded)
                    .context("CLERK_PUBLISHABLE_KEY must encode a frontend API host")?;
                let host = decoded.strip_suffix('$').unwrap_or(&decoded);
                if host.is_empty()
                    || host.len() > 253
                    || !host.split('.').all(|label| {
                        !label.is_empty()
                            && label.len() <= 63
                            && !label.starts_with('-')
                            && !label.ends_with('-')
                            && label
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    })
                {
                    bail!("CLERK_PUBLISHABLE_KEY must encode a frontend API host");
                }
                Ok(format!("https://{host}"))
            })
            .transpose()?;
        let Some(issuer) = get("CLERK_ISSUER").or(derived_issuer) else {
            return Ok(None);
        };
        Ok(Some(Self {
            jwks_url: get("CLERK_JWKS_URL")
                .unwrap_or_else(|| format!("{issuer}/.well-known/jwks.json")),
            issuer,
            api_url: get("CLERK_API_URL").unwrap_or_else(|| "https://api.clerk.com".into()),
            authorized_parties: get("CLERK_AUTHORIZED_PARTIES")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|party| !party.is_empty())
                .map(str::to_owned)
                .collect(),
            secret_key: get("CLERK_SECRET_KEY"),
        }))
    }
}

// No Debug: contains the signing secret.
#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: Option<String>,
    pub redis_url: Option<String>,
    pub encoder: Option<PathBuf>,
    pub decoder: Option<PathBuf>,
    pub dino_model: Option<PathBuf>,
    pub ocr_det: Option<PathBuf>,
    pub ocr_encoder: Option<PathBuf>,
    pub ocr_decoder: Option<PathBuf>,
    pub ocr_vocab: Option<PathBuf>,
    pub ocr_threads: usize,
    pub jwt_secret: String,
    pub clerk: Option<ClerkSettings>,
    pub db_max_connections: u32,
    pub rate_limits: RateLimits,
    pub client_ip: ClientIpSource,
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
        let clerk = ClerkSettings::from_lookup(&get)?;
        let db_max_connections = get("DB_MAX_CONNECTIONS")
            .unwrap_or_else(|| "10".into())
            .parse()
            .context("DB_MAX_CONNECTIONS must be a positive integer")?;
        if db_max_connections == 0 {
            bail!("DB_MAX_CONNECTIONS must be a positive integer");
        }
        let positive = |name: &str, default: u32| -> anyhow::Result<u32> {
            let value = match get(name) {
                Some(raw) => raw
                    .parse()
                    .with_context(|| format!("{name} must be a positive integer"))?,
                None => default,
            };
            if value == 0 {
                bail!("{name} must be a positive integer");
            }
            Ok(value)
        };
        let ocr_det = get("OCR_DET_PATH").map(PathBuf::from);
        let ocr_encoder = get("OCR_ENCODER_PATH").map(PathBuf::from);
        let ocr_decoder = get("OCR_DECODER_PATH").map(PathBuf::from);
        let ocr_vocab = get("OCR_VOCAB_PATH").map(PathBuf::from);
        let configured = [&ocr_det, &ocr_encoder, &ocr_decoder, &ocr_vocab]
            .iter()
            .filter(|p| p.is_some())
            .count();
        if configured != 0 && configured != 4 {
            bail!(
                "set all OCR_DET_PATH, OCR_ENCODER_PATH, OCR_DECODER_PATH and OCR_VOCAB_PATH, or none"
            );
        }
        let ocr_threads = positive("OCR_THREADS", 4)? as usize;
        let defaults = RateLimits::default();
        let rate_limits = RateLimits {
            store_create_per_hour: positive(
                "RATE_LIMIT_STORE_CREATE_PER_HOUR",
                defaults.store_create_per_hour,
            )?,
            join_per_hour: positive("RATE_LIMIT_JOIN_PER_HOUR", defaults.join_per_hour)?,
            recover_per_10min: positive(
                "RATE_LIMIT_RECOVER_PER_10MIN",
                defaults.recover_per_10min,
            )?,
            pin_attempts: positive("RATE_LIMIT_PIN_ATTEMPTS", defaults.pin_attempts)?,
        };
        let hops = positive("TRUSTED_PROXY_HOPS", 1)? as usize;
        let client_ip = ClientIpSource::parse(
            &get("CLIENT_IP_SOURCE").unwrap_or_else(|| "peer".into()),
            hops,
        )?;
        Ok(Self {
            ocr_det,
            ocr_encoder,
            ocr_decoder,
            ocr_vocab,
            ocr_threads,
            rate_limits,
            client_ip,
            port: get("PORT")
                .unwrap_or_else(|| "8080".into())
                .parse()
                .context("PORT must be a u16")?,
            database_url: get("DATABASE_URL"),
            redis_url: get("REDIS_URL"),
            encoder: get("SAM_ENCODER_PATH").map(PathBuf::from),
            decoder: get("SAM_DECODER_PATH").map(PathBuf::from),
            dino_model: get("DINO_MODEL_PATH").map(PathBuf::from),
            jwt_secret,
            clerk,
            db_max_connections,
        })
    }
    /// Optional OCR adapter. Its detector() shares the detection session with scan callers.
    pub fn ocr(&self) -> anyhow::Result<Option<Arc<VietOcr>>> {
        match (
            &self.ocr_det,
            &self.ocr_encoder,
            &self.ocr_decoder,
            &self.ocr_vocab,
        ) {
            (None, None, None, None) => Ok(None),
            (Some(det), Some(enc), Some(dec), Some(vocab)) => {
                let paths = [det, enc, dec, vocab];
                if paths.iter().all(|p| !p.exists()) {
                    tracing::warn!("OCR weights absent; receipt OCR is unavailable");
                    return Ok(None);
                }
                if paths.iter().any(|p| !p.is_file()) {
                    bail!("OCR model files must all be present");
                }
                let detector = Arc::new(PpOcrDetector::load(det, self.ocr_threads)?);
                Ok(Some(Arc::new(VietOcr::load(
                    detector,
                    enc,
                    dec,
                    vocab,
                    self.ocr_threads,
                )?)))
            }
            _ => bail!("set all four OCR paths, or none"),
        }
    }
    pub fn sam_segmenter(&self) -> anyhow::Result<Option<Arc<SamSegmenter>>> {
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
    pub fn segmenter(&self) -> anyhow::Result<Option<Arc<dyn Segmenter>>> {
        Ok(self.sam_segmenter()?.map(|s| s as Arc<dyn Segmenter>))
    }
    pub fn embedder(&self) -> anyhow::Result<Option<Arc<dyn Embedder>>> {
        match &self.dino_model {
            None => Ok(None),
            Some(model) if !model.exists() => {
                tracing::warn!("DINO weights absent; scan recognition is unavailable");
                Ok(None)
            }
            Some(model) => Ok(Some(Arc::new(DinoEmbedder::load(model, 0)?))),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ocr_paths_are_all_or_none_and_threads_are_positive() {
        let keys = [
            "OCR_DET_PATH",
            "OCR_ENCODER_PATH",
            "OCR_DECODER_PATH",
            "OCR_VOCAB_PATH",
        ];
        for mask in 0u8..16 {
            let config = Config::from_lookup(|name| {
                if name == "JWT_SECRET" {
                    return Some("x".repeat(32));
                }
                keys.iter()
                    .position(|k| *k == name)
                    .filter(|i| mask & (1 << i) != 0)
                    .map(|_| "/missing/ocr".into())
            });
            if mask == 0 || mask == 15 {
                let config = config.unwrap();
                assert_eq!(config.ocr_threads, 4);
                assert!(config.ocr().unwrap().is_none());
            } else {
                assert!(config.err().unwrap().to_string().contains("OCR_"));
            }
        }
        for value in ["0", "bad", "-1"] {
            assert!(
                Config::from_lookup(|name| match name {
                    "JWT_SECRET" => Some("x".repeat(32)),
                    "OCR_THREADS" => Some(value.into()),
                    _ => None,
                })
                .is_err()
            );
        }
        let config = Config::from_lookup(|name| match name {
            "JWT_SECRET" => Some("x".repeat(32)),
            "OCR_THREADS" => Some("2".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(config.ocr_threads, 2);
    }
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
        assert_eq!(defaults.rate_limits, RateLimits::default());
        assert_eq!(defaults.client_ip, ClientIpSource::Peer);
        assert!(defaults.segmenter().unwrap().is_none());
        for (key, value) in [
            ("PORT", "65536"),
            ("DB_MAX_CONNECTIONS", "0"),
            ("DB_MAX_CONNECTIONS", "bad"),
            ("RATE_LIMIT_PIN_ATTEMPTS", "0"),
            ("RATE_LIMIT_JOIN_PER_HOUR", "x"),
            ("CLIENT_IP_SOURCE", "spoofable"),
            ("TRUSTED_PROXY_HOPS", "0"),
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
            if name.starts_with("CLERK_") {
                return None;
            }
            Some(match name {
                "JWT_SECRET" => "x".repeat(32),
                "PORT" => "9000".into(),
                "DB_MAX_CONNECTIONS" => "24".into(),
                "OCR_THREADS" => "4".into(),
                "RATE_LIMIT_PIN_ATTEMPTS" => "3".into(),
                "CLIENT_IP_SOURCE" => "x-real-ip".into(),
                "TRUSTED_PROXY_HOPS" => "2".into(),
                n if n.starts_with("RATE_LIMIT_") => "7".into(),
                _ => name.into(),
            })
        })
        .unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(config.db_max_connections, 24);
        assert_eq!(config.rate_limits.pin_attempts, 3);
        assert_eq!(config.rate_limits.join_per_hour, 7);
        assert_eq!(config.client_ip, ClientIpSource::XRealIp);
        assert_eq!(config.database_url.as_deref(), Some("DATABASE_URL"));
        assert_eq!(config.redis_url.as_deref(), Some("REDIS_URL"));
        assert_eq!(config.encoder, Some(PathBuf::from("SAM_ENCODER_PATH")));
        assert_eq!(config.decoder, Some(PathBuf::from("SAM_DECODER_PATH")));
    }
}
