use std::{net::SocketAddr, sync::Arc};
use taphoa_api::{
    AppState,
    config::Config,
    events,
    recognition::classify::RecognitionConfig,
    retention, router,
    storage::{S3Store, StorageConfig},
    vector::VectorIndex,
};
use tracing_subscriber::EnvFilter;

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
    let mut state = AppState::connect_with_config(&config, config.segmenter()?).await?;
    state.embedder = config.embedder()?;
    state.recognition = RecognitionConfig::from_env()?;
    state.vector_index = state.postgres.clone().map(|pool| {
        Arc::new(taphoa_api::recognition::pgvector::PgVectorIndex::new(pool))
            as Arc<dyn VectorIndex>
    });
    if let Some(config) = storage_config {
        let storage = S3Store::new(&config).await;
        if config.create_bucket {
            storage.ensure_bucket().await?;
        }
        state.image_url_ttl = config.url_ttl;
        state.storage = Some(Arc::new(storage));
    }
    // Real adapters arrive with the recognition epic; EMBEDDER=mock is for local/e2e only.
    if std::env::var("EMBEDDER").as_deref() == Ok("mock") {
        state.embedder = Some(Arc::new(taphoa_recognition::MockEmbedder));
    }
    let pool = state.postgres.clone();
    let (stop, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut background = events::spawn_background(&state, shutdown_rx.clone());
    if let Some(pool) = pool.clone() {
        background.push(retention::spawn(pool, shutdown_rx));
    }
    let address = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "API listening");
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown().await;
        let _ = stop.send(true);
    })
    .await?;
    for task in background {
        task.await?;
    }
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
