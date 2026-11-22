use std::{
    future::{Future, IntoFuture},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};
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

const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const RUNTIME_TIMEOUT: Duration = Duration::from_secs(1);

fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    // Dropping a Tokio runtime otherwise waits forever for detached native loaders.
    runtime.shutdown_timeout(RUNTIME_TIMEOUT);
    result
}
async fn run() -> anyhow::Result<()> {
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
    let mut state = AppState::connect_with_config(&config, None).await?;
    state.models = taphoa_api::models::LazyModels::from_config(&config)?;
    state.remote_models =
        taphoa_api::remote_models::RemoteModels::from_config(&config, state.clone())?;
    state.push = Some(Arc::new(taphoa_api::push::ExpoPush::new(
        taphoa_api::push::PushConfig::from_env()?,
    )?));
    if let Some(analytics) = analytics {
        state.analytics = analytics;
        tracing::info!("posthog analytics enabled");
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
    let voice_config = taphoa_api::voice::VoiceConfig::from_env()?;
    match voice_config.provider {
        taphoa_api::voice::VoiceProvider::OpenRouter => {
            state.voice.model = OpenRouterConfig::from_env()?
                .map(|c| {
                    taphoa_api::voice::model::OpenRouterVoice::new(
                        c,
                        voice_config.model_timeout,
                        voice_config.require_zdr,
                    )
                })
                .transpose()?
                .map(|client| Arc::new(client) as Arc<dyn taphoa_api::voice::VoiceModel>);
        }
        taphoa_api::voice::VoiceProvider::Scripted => {
            tracing::warn!("voice uses the scripted provider for local/e2e runs");
            state.voice.model = Some(Arc::new(taphoa_api::voice::scripted::MarkerVoiceModel));
        }
    }
    state.voice.config = Arc::new(voice_config);
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
    if let Some(remote) = &state.remote_models {
        background.push(remote.spawn_monitor(shutdown_rx.clone()));
    }
    if let Some(pool) = pool.clone() {
        background.push(retention::spawn(pool.clone(), shutdown_rx.clone()));
        background.push(taphoa_api::voice::retention::spawn(
            pool.clone(),
            shutdown_rx.clone(),
        ));
        if let Some(storage) = state.storage.clone() {
            background.push(taphoa_api::voice::retention::spawn_donated(
                pool.clone(),
                storage,
                state.voice.config.donated_retention_days,
                shutdown_rx.clone(),
            ));
        } else {
            match sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM voice_donations)")
                .fetch_one(&pool)
                .await
            {
                Ok(true) => tracing::warn!(
                    "donated voice clips cannot be deleted: object storage is not configured"
                ),
                Ok(false) => {}
                Err(_) => {
                    tracing::warn!("could not check for donated clips while storage is missing")
                }
            }
        }
        if digest_config.enabled {
            background.push(digest_job::spawn(
                state.clone(),
                digest_config,
                shutdown_rx.clone(),
            ));
        }
        // Spawn the index-job worker only when all required dependencies are present.
        if let (Some(embedder), Some(storage)) = (state.embedding_holder(), state.storage.clone()) {
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
    let models = state.models.clone();
    let mut server_shutdown = stop.subscribe();
    let server = axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        while !*server_shutdown.borrow_and_update() {
            if server_shutdown.changed().await.is_err() {
                break;
            }
        }
    })
    .into_future();
    tokio::pin!(server);
    let server_result = tokio::select! {
        result = &mut server => Some(result),
        () = shutdown() => None,
    };
    // Stop accepting, release cold-load waiters, then share one drain bound across
    // HTTP, background jobs and database cleanup before capture/telemetry flush.
    stop.send_replace(true);
    models.shutdown();
    if let Some(result) = bounded_drain(
        async {
            let server_result = match server_result {
                Some(result) => result,
                None => server.await,
            };
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
            Ok::<_, anyhow::Error>(())
        },
        DRAIN_TIMEOUT,
    )
    .await
    {
        result?;
    }
    Ok(())
}

async fn bounded_drain<T>(work: impl Future<Output = T>, bound: Duration) -> Option<T> {
    match tokio::time::timeout(bound, work).await {
        Ok(result) => Some(result),
        Err(_) => {
            tracing::warn!("request/job drain timed out; continuing shutdown flush");
            None
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn drain_is_bounded_and_preserves_completed_results() {
        assert_eq!(
            bounded_drain(async { 42 }, Duration::from_millis(10)).await,
            Some(42)
        );
        let start = std::time::Instant::now();
        assert_eq!(
            bounded_drain(std::future::pending::<()>(), Duration::from_millis(20)).await,
            None
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn runtime_shutdown_does_not_wait_for_detached_loader() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let (started, ready) = std::sync::mpsc::channel();
        runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            let _ = wait.recv();
        });
        ready.recv().unwrap();
        let start = std::time::Instant::now();
        runtime.shutdown_timeout(Duration::from_millis(20));
        release.send(()).unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
