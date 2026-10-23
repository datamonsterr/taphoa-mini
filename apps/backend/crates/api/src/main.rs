use anyhow::{Context, bail};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use taphoa_api::{
    AppState, router,
    storage::{S3Store, StorageConfig},
};
use taphoa_recognition::{SamOptions, SamSegmenter, Segmenter};
use tracing_subscriber::EnvFilter;

struct Config {
    port: u16,
    database_url: Option<String>,
    redis_url: Option<String>,
    encoder: Option<PathBuf>,
    decoder: Option<PathBuf>,
}
impl Config {
    fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "8080".into())
                .parse()
                .context("PORT must be a u16")?,
            database_url: std::env::var("DATABASE_URL").ok(),
            redis_url: std::env::var("REDIS_URL").ok(),
            encoder: std::env::var_os("SAM_ENCODER_PATH").map(PathBuf::from),
            decoder: std::env::var_os("SAM_DECODER_PATH").map(PathBuf::from),
        })
    }
    fn segmenter(&self) -> anyhow::Result<Option<Arc<dyn Segmenter>>> {
        match (&self.encoder, &self.decoder) {
            (None, None) => Ok(None),
            (Some(encoder), Some(decoder)) if !encoder.exists() && !decoder.exists() => {
                tracing::warn!("SAM weights absent; segmentation is unavailable");
                Ok(None)
            }
            (Some(encoder), Some(decoder)) => Ok(Some(Arc::new(SamSegmenter::load(
                encoder,
                decoder,
                SamOptions::default(),
            )?))),
            _ => bail!("set both SAM_ENCODER_PATH and SAM_DECODER_PATH, or neither"),
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("taphoa_api=info,tower_http=info"));
    if std::env::var("LOG_FORMAT").as_deref() == Ok("json") {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    let config = Config::from_env()?;
    let storage_config = StorageConfig::from_env()?;
    let mut state = AppState::connect(
        config.database_url.as_deref(),
        config.redis_url.as_deref(),
        config.segmenter()?,
    )
    .await?;
    if let Some(config) = storage_config {
        let storage = S3Store::new(&config).await;
        if config.create_bucket {
            storage.ensure_bucket().await?;
        }
        state.image_url_ttl = config.url_ttl;
        state.storage = Some(Arc::new(storage));
    }
    let pool = state.postgres.clone();
    let address = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "API listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    if let Some(pool) = pool {
        pool.close().await;
    }
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { () = ctrl_c => {}, () = terminate => {} }
    tracing::info!("shutdown requested; draining requests");
}
