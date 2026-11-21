//! One cancellable wait, one blocking loader, and leases that pin a model during inference.
use std::{
    ops::Deref,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};

pub const LOAD_TIMEOUT: Duration = Duration::from_secs(120);
type LoadResult = Option<Result<(), String>>;
type Loader<T> = dyn Fn() -> anyhow::Result<Arc<T>> + Send + Sync;

pub struct ModelHolder<T: ?Sized> {
    inner: Arc<Inner<T>>,
}
struct Inner<T: ?Sized> {
    name: &'static str,
    loader: Box<Loader<T>>,
    state: Mutex<State<T>>,
    idle: Duration,
}
struct State<T: ?Sized> {
    model: Option<Arc<T>>,
    loading: Option<watch::Receiver<LoadResult>>,
    active: usize,
    last_used: Instant,
    load_ms: u64,
}
impl<T: ?Sized> Clone for ModelHolder<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

/// Clones and projections retain the same lease, including inside spawn_blocking after
/// request cancellation. No raw model Arc escapes the holder's production call sites.
pub struct ModelLease<T: ?Sized> {
    model: Arc<T>,
    usage: Arc<Usage>,
}
struct Usage {
    release: Option<Box<dyn FnOnce() + Send + Sync>>,
}
impl Drop for Usage {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}
impl<T: ?Sized> Clone for ModelLease<T> {
    fn clone(&self) -> Self {
        Self {
            model: self.model.clone(),
            usage: self.usage.clone(),
        }
    }
}
impl<T: ?Sized> Deref for ModelLease<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.model
    }
}
impl<T: ?Sized> ModelLease<T> {
    pub fn fixed(model: Arc<T>) -> Self {
        Self {
            model,
            usage: Arc::new(Usage { release: None }),
        }
    }
    pub fn map<U: ?Sized>(self, project: impl FnOnce(&Arc<T>) -> Arc<U>) -> ModelLease<U> {
        ModelLease {
            model: project(&self.model),
            usage: self.usage.clone(),
        }
    }
}
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct LoadTiming {
    pub load_ms: u64,
    pub already_loaded: bool,
}

impl<T: ?Sized + Send + Sync + 'static> ModelHolder<T> {
    pub fn new(
        name: &'static str,
        idle: Duration,
        loader: impl Fn() -> anyhow::Result<Arc<T>> + Send + Sync + 'static,
    ) -> Self {
        let inner = Arc::new(Inner {
            name,
            loader: Box::new(loader),
            idle,
            state: Mutex::new(State {
                model: None,
                loading: None,
                active: 0,
                last_used: Instant::now(),
                load_ms: 0,
            }),
        });
        if !idle.is_zero() {
            let weak = Arc::downgrade(&inner);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(idle.min(Duration::from_secs(30))).await;
                    let Some(inner) = weak.upgrade() else { break };
                    // Session destruction and allocator trimming must also stay off the executor.
                    let holder = Self { inner };
                    if let Err(error) =
                        tokio::task::spawn_blocking(move || holder.unload_if_idle()).await
                    {
                        tracing::error!(%error, "model unload task failed");
                    }
                }
            });
        }
        Self { inner }
    }

    pub async fn get(&self) -> anyhow::Result<ModelLease<T>> {
        self.get_with_timing().await.map(|(lease, _)| lease)
    }
    pub async fn get_with_timing(&self) -> anyhow::Result<(ModelLease<T>, LoadTiming)> {
        tokio::time::timeout(LOAD_TIMEOUT, self.acquire())
            .await
            .map_err(|_| anyhow::anyhow!("{} model load timed out", self.inner.name))?
    }
    async fn acquire(&self) -> anyhow::Result<(ModelLease<T>, LoadTiming)> {
        let mut already_loaded = true;
        loop {
            let mut receiver = {
                let mut state = self.inner.state.lock().unwrap();
                if let Some(model) = state.model.clone() {
                    state.active += 1;
                    let weak = Arc::downgrade(&self.inner);
                    let usage = Arc::new(Usage {
                        release: Some(Box::new(move || {
                            if let Some(inner) = weak.upgrade() {
                                let mut state = inner.state.lock().unwrap();
                                state.active -= 1;
                                state.last_used = Instant::now();
                            }
                        })),
                    });
                    return Ok((
                        ModelLease { model, usage },
                        LoadTiming {
                            load_ms: state.load_ms,
                            already_loaded,
                        },
                    ));
                }
                already_loaded = false;
                match &state.loading {
                    Some(receiver) => receiver.clone(),
                    None => {
                        let (sender, receiver) = watch::channel(None);
                        state.loading = Some(receiver.clone());
                        let inner = self.inner.clone();
                        // The load survives timeout/cancellation of every waiter.
                        tokio::spawn(async move {
                            let started = Instant::now();
                            let loader_inner = inner.clone();
                            // Family loading creates sessions only and runs no inference; inference starts when a caller uses its lease.
                            let loaded =
                                tokio::task::spawn_blocking(move || (loader_inner.loader)()).await;
                            let result = loaded.map_err(anyhow::Error::from).and_then(|r| r);
                            let mut state = inner.state.lock().unwrap();
                            let result = match result {
                                Ok(model) => {
                                    state.model = Some(model);
                                    state.load_ms = started.elapsed().as_millis() as u64;
                                    state.last_used = Instant::now();
                                    tracing::info!(
                                        family = inner.name,
                                        load_ms = state.load_ms,
                                        "model loaded"
                                    );
                                    Ok(())
                                }
                                Err(error) => {
                                    tracing::error!(family = inner.name, %error, "model load failed");
                                    Err(error.to_string())
                                }
                            };
                            state.loading = None;
                            let _ = sender.send(Some(result));
                        });
                        receiver
                    }
                }
            };
            let result = receiver
                .wait_for(|result| result.is_some())
                .await
                .map_err(|_| anyhow::anyhow!("model loader stopped"))?
                .clone()
                .unwrap();
            result.map_err(anyhow::Error::msg)?;
        }
    }

    fn unload_if_idle(&self) -> bool {
        let (model, sender) = {
            let mut state = self.inner.state.lock().unwrap();
            if self.inner.idle.is_zero()
                || state.active != 0
                || state.last_used.elapsed() < self.inner.idle
            {
                return false;
            }
            let Some(model) = state.model.take() else {
                return false;
            };
            let (sender, receiver) = watch::channel(None);
            // New acquisitions await destruction before starting a fresh load.
            state.loading = Some(receiver);
            (model, sender)
        };
        drop(model);
        release_unused_memory();
        let mut state = self.inner.state.lock().unwrap();
        state.loading = None;
        let _ = sender.send(Some(Ok(())));
        tracing::info!(family = self.inner.name, "model unloaded");
        true
    }
}

/// glibc keeps freed session allocations in arenas; return their unused pages after unload.
fn release_unused_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        // SAFETY: glibc malloc_trim is thread safe and accepts zero padding.
        malloc_trim(0);
    }
}

/// Fixed adapters are for tests and explicitly configured mocks only.
impl<T: ?Sized + Send + Sync + 'static> From<Arc<T>> for ModelHolder<T> {
    fn from(model: Arc<T>) -> Self {
        Self::new("mock", Duration::ZERO, move || Ok(model.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fake(idle: Duration) -> (ModelHolder<usize>, Arc<AtomicUsize>) {
        let loads = Arc::new(AtomicUsize::new(0));
        let count = loads.clone();
        (
            ModelHolder::new("fake", idle, move || {
                std::thread::sleep(Duration::from_millis(20));
                Ok(Arc::new(count.fetch_add(1, Ordering::SeqCst)))
            }),
            loads,
        )
    }
    fn expire<T: ?Sized>(holder: &ModelHolder<T>) {
        holder.inner.state.lock().unwrap().last_used = Instant::now() - Duration::from_secs(60);
    }
    #[tokio::test]
    async fn concurrent_first_requests_load_once() {
        let (holder, loads) = fake(Duration::from_secs(10));
        let results =
            futures_util::future::join_all((0..32).map(|_| holder.get_with_timing())).await;
        for result in results {
            let (lease, timing) = result.unwrap();
            assert_eq!(*lease, 0);
            assert!(!timing.already_loaded);
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(holder.get_with_timing().await.unwrap().1.already_loaded);
    }
    #[tokio::test]
    async fn unload_after_idle_and_reload() {
        let (holder, loads) = fake(Duration::from_secs(10));
        drop(holder.get().await.unwrap());
        assert!(!holder.unload_if_idle());
        expire(&holder);
        assert!(holder.unload_if_idle());
        assert!(holder.inner.state.lock().unwrap().model.is_none());
        assert_eq!(*holder.get().await.unwrap(), 1);
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn no_unload_during_blocking_inference_or_cloned_lease() {
        let (holder, _) = fake(Duration::from_secs(10));
        let lease = holder.get().await.unwrap();
        let inference_lease = lease.clone();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tokio::task::spawn_blocking(move || {
            wait.recv().unwrap();
            assert_eq!(*inference_lease, 0);
        });
        drop(lease);
        expire(&holder);
        assert!(!holder.unload_if_idle());
        release.send(()).unwrap();
        task.await.unwrap();
        // Idle starts at inference completion, not at acquisition.
        assert!(!holder.unload_if_idle());
        expire(&holder);
        assert!(holder.unload_if_idle());
    }
    #[tokio::test]
    async fn zero_idle_never_unloads() {
        let (holder, loads) = fake(Duration::ZERO);
        drop(holder.get().await.unwrap());
        expire(&holder);
        assert!(!holder.unload_if_idle());
        drop(holder.get().await.unwrap());
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancelled_waiter_does_not_cancel_or_duplicate_load() {
        let (holder, loads) = fake(Duration::from_secs(10));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), holder.get())
                .await
                .is_err()
        );
        assert_eq!(*holder.get().await.unwrap(), 0);
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn failed_loader_can_retry() {
        let loads = Arc::new(AtomicUsize::new(0));
        let count = loads.clone();
        let holder = ModelHolder::new("retry", Duration::ZERO, move || {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                anyhow::bail!("fake load failure");
            }
            Ok(Arc::new(42))
        });
        assert!(holder.get().await.is_err());
        assert_eq!(*holder.get().await.unwrap(), 42);
    }
}

#[cfg(test)]
mod real_model_tests {
    use super::*;
    use taphoa_recognition::{PointPrompt, PointSegmenter, SamOptions, SamSegmenter};

    #[tokio::test]
    #[ignore = "requires real SAM models and ORT_DYLIB_PATH"]
    async fn cached_encoding_survives_session_unload() {
        let model_files_present = ["SAM_ENCODER_PATH", "SAM_DECODER_PATH"]
            .into_iter()
            .all(|var| {
                std::env::var_os(var).is_some_and(|path| std::path::Path::new(&path).is_file())
            });
        let runtime_present = std::env::var_os("ORT_DYLIB_PATH")
            .is_some_and(|path| std::path::Path::new(&path).is_file());
        if !model_files_present || !runtime_present {
            eprintln!(
                "SKIP cached_encoding_survives_session_unload: SAM models or ORT runtime not present"
            );
            return;
        }

        let holder = ModelHolder::new("sam", Duration::from_secs(300), || {
            Ok(Arc::new(SamSegmenter::load(
                std::path::Path::new(&std::env::var("SAM_ENCODER_PATH")?),
                std::path::Path::new(&std::env::var("SAM_DECODER_PATH")?),
                SamOptions::from_env(),
            )?))
        });
        let sam = holder.get().await.unwrap();
        let encoding = sam
            .encode(include_bytes!("../../../tests/fixtures/shelf-1024.jpg"))
            .unwrap();
        drop(sam);
        holder.inner.state.lock().unwrap().last_used = Instant::now() - Duration::from_secs(360);
        assert!(holder.unload_if_idle());
        let sam = holder.get().await.unwrap();
        let result = sam.decode_points(
            &encoding,
            &[PointPrompt {
                x: 98.6,
                y: 179.2,
                label: 1,
            }],
        );
        assert!(result.is_ok());
    }
}
