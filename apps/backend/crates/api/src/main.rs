use std::{net::SocketAddr, sync::Arc};
use taphoa_api::{
    AppState,
    analytics::{PostHogAnalytics, PostHogConfig},
    assistant::{
        config::{AssistantConfig, ModelProvider},
        digest::job::{self as digest_job, DigestJobConfig},
        model::{
            openrouter::{OpenRouterChat, OpenRouterConfig},
            rules::RuleModel,
        },
    },
    catalog::index_jobs::{WorkerConfig, spawn as spawn_index_worker},
    config::Config,
    events,
    recognition::classify::RecognitionConfig,
    retention, router,
    storage::{S3Store, StorageConfig},
    vector::VectorIndex,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Both ring and aws-lc-rs are linked, so rustls cannot pick a process default itself.
    // Install ring before anything builds a TLS client (telemetry, sqlx, S3, reqwest).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let telemetry = taphoa_api::telemetry::init(taphoa_api::telemetry::TelemetryConfig::from_env());
    let analytics = PostHogConfig::from_env().map(|config| Arc::new(PostHogAnalytics::new(config)));
    let result = serve(analytics.clone()).await;
    if let Some(analytics) = analytics {
        analytics.shutdown().await;
    }
    if let Err(error) = &result {
        // Startup and serve failures must reach the exported logs before the flush.
        taphoa_api::error::log_fatal(error);
    }
    // Flush on startup/server errors as well as after graceful task shutdown.
    telemetry.shutdown();
    result
}

async fn serve(analytics: Option<Arc<PostHogAnalytics>>) -> anyhow::Result<()> {
    let assistant_config = AssistantConfig::from_env()?;
    let digest_config = DigestJobConfig::from_env()?;
    let config = Config::from_env()?;
    let storage_config = StorageConfig::from_env()?;
    let sam = config.sam_segmenter()?;
    let segmenter = sam
        .as_ref()
        .map(|s| Arc::clone(s) as Arc<dyn taphoa_recognition::Segmenter>);
    let point_segmenter = sam.map(|s| s as Arc<dyn taphoa_recognition::PointSegmenter>);
    let mut state = AppState::connect_with_config(&config, segmenter).await?;
    state.push = Some(Arc::new(taphoa_api::push::ExpoPush::new(
        taphoa_api::push::PushConfig::from_env()?,
    )?));
    if let Some(analytics) = analytics {
        state.analytics = analytics;
        tracing::info!("posthog analytics enabled");
    }
    state.point_segmenter = point_segmenter;
    if let Some(ocr) = config.ocr()? {
        state.text_detector = Some(ocr.detector());
        state.receipt_ocr = Some(ocr);
    }
    state.decisions = taphoa_api::decisions::DecisionsConfig::from_env()?
        .map(taphoa_api::decisions::OpenRouterDecisions::new)
        .transpose()?
        .map(|client| Arc::new(client) as Arc<dyn taphoa_api::decisions::DecisionClient>);
    state.assistant.config = Arc::new(assistant_config);
    if state.assistant.config.model_provider == ModelProvider::OpenRouter {
        state.assistant.model = OpenRouterConfig::from_env()?
            .map(OpenRouterChat::new)
            .transpose()?
            .map(|client| Arc::new(client) as Arc<dyn taphoa_api::assistant::model::ChatModel>);
    }
    if state.assistant.config.model_provider == ModelProvider::Scripted {
        tracing::warn!("assistant uses the scripted provider for local/e2e runs");
        state.assistant.model = Some(Arc::new(RuleModel));
    }
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
    let address = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    let pool = state.postgres.clone();
    let (stop, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut background = events::spawn_background(&state, shutdown_rx.clone());
    if let Some(pool) = pool.clone() {
        background.push(retention::spawn(pool.clone(), shutdown_rx.clone()));
        if digest_config.enabled {
            background.push(digest_job::spawn(
                state.clone(),
                digest_config,
                shutdown_rx.clone(),
            ));
        }
        // Spawn the index-job worker only when all required dependencies are present.
        if let (Some(embedder), Some(storage)) = (state.embedder.clone(), state.storage.clone()) {
            background.push(spawn_index_worker(
                pool,
                embedder,
                storage,
                state.inference_slots.clone(),
                shutdown_rx,
                WorkerConfig::default(),
            ));
        }
    }
    tracing::info!(%address, "API listening");
    let shutdown_stop = stop.clone();
    let server_result = axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown().await;
        let _ = shutdown_stop.send(true);
    })
    .await;
    let _ = stop.send(true);
    let mut task_result = Ok(());
    for task in background {
        if let Err(error) = task.await {
            task_result = Err(error);
        }
    }
    if let Some(pool) = pool {
        pool.close().await;
    }
    server_result?;
    task_result?;
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
