//! One request budget across admission, model loading, remote stages and storage.
use axum::{
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use taphoa_recognition::{EmbedError, Embedder, SegmentError, Segmenter, work::WorkControl};

/// Mobile useScanSession.ts allows 20 seconds; leave two seconds for the response.
pub const REQUEST_BUDGET: Duration = Duration::from_secs(18);
tokio::task_local! { static REQUEST_WORK: WorkControl; }
type Admission = Arc<Mutex<Option<tokio::sync::OwnedSemaphorePermit>>>;
type Admissions = Arc<Mutex<Vec<Weak<Mutex<Option<tokio::sync::OwnedSemaphorePermit>>>>>>;
tokio::task_local! { static REQUEST_ADMISSIONS: Admissions; }
/// Native work retains admission on success. Cancellation explicitly releases it,
/// while the shared work control prevents any further native stages from starting.
pub(crate) fn admit(permit: tokio::sync::OwnedSemaphorePermit) -> Admission {
    let admission = Arc::new(Mutex::new(Some(permit)));
    let _ = REQUEST_ADMISSIONS
        .try_with(|admissions| admissions.lock().unwrap().push(Arc::downgrade(&admission)));
    admission
}
struct CancelOnDrop {
    control: WorkControl,
    admissions: Admissions,
    completed: bool,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.control.cancel();
        if !self.completed {
            for admission in self
                .admissions
                .lock()
                .unwrap()
                .iter()
                .filter_map(Weak::upgrade)
            {
                admission.lock().unwrap().take();
            }
        }
    }
}

pub async fn request_deadline(request: Request, next: Next) -> Response {
    request_deadline_with_budget(request, next, REQUEST_BUDGET).await
}
async fn request_deadline_with_budget(request: Request, next: Next, budget: Duration) -> Response {
    let path = request.uri().path();
    let inference = request.method() == axum::http::Method::POST
        && (matches!(
            path,
            "/v1/segment"
                | "/v1/segment/points"
                | "/v1/recognition/scans"
                | "/v1/recognition/document-probes"
                | "/v1/receipts"
                | "/v1/products"
        ) || (path.starts_with("/v1/products/") && path.ends_with("/images")));
    if !inference {
        return next.run(request).await;
    }
    within_budget(budget, next.run(request))
        .await
        .unwrap_or_else(|| crate::busy().into_response())
}
async fn within_budget<T>(budget: Duration, work: impl Future<Output = T>) -> Option<T> {
    let control = WorkControl::new(Instant::now() + budget);
    let admissions = Arc::new(Mutex::new(Vec::new()));
    let mut cancel = CancelOnDrop {
        control: control.clone(),
        admissions: admissions.clone(),
        completed: false,
    };
    let result = REQUEST_ADMISSIONS
        .scope(
            admissions,
            REQUEST_WORK.scope(control, async {
                tokio::time::timeout(budget, work).await.ok()
            }),
        )
        .await;
    cancel.completed = result.is_some() && cancel.control.check().is_ok();
    result
}

/// Propagate the same cooperative control into every blocking stage of a request.
pub(crate) fn spawn_blocking<F, R>(work: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let control = REQUEST_WORK.try_with(Clone::clone).ok();
    tokio::task::spawn_blocking(move || taphoa_recognition::work::scope(control, work))
}
pub(crate) fn segment(
    model: &dyn Segmenter,
    image: &[u8],
) -> Result<Vec<taphoa_recognition::Segment>, SegmentError> {
    match taphoa_recognition::work::current() {
        Some(control) => model.segment_with_control(image, &control),
        None => model.segment(image),
    }
}
pub(crate) fn embed(model: &dyn Embedder, image: &[u8]) -> Result<Vec<f32>, EmbedError> {
    match taphoa_recognition::work::current() {
        Some(control) => model.embed_with_control(image, &control),
        None => model.embed(image),
    }
}
pub(crate) fn embed_crops(
    model: &dyn Embedder,
    crops: &[image::RgbImage],
) -> Result<Vec<Vec<f32>>, EmbedError> {
    match taphoa_recognition::work::current() {
        Some(control) => model.embed_crops_with_control(crops, &control),
        None => model.embed_crops(crops),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use taphoa_recognition::{Segment, work::Cancelled};
    #[tokio::test]
    async fn slow_local_work_is_cancelled_and_request_permit_is_released() {
        struct Slow(Arc<AtomicBool>);
        impl Segmenter for Slow {
            fn segment(&self, _: &[u8]) -> Result<Vec<Segment>, SegmentError> {
                panic!("must use cancellation hook")
            }
            fn segment_with_control(
                &self,
                _: &[u8],
                control: &WorkControl,
            ) -> Result<Vec<Segment>, SegmentError> {
                while control.check().is_ok() {
                    std::thread::sleep(Duration::from_millis(2));
                }
                self.0.store(true, Ordering::SeqCst);
                Err(Cancelled.into())
            }
        }
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let done = Arc::new(AtomicBool::new(false));
        let model = Slow(done.clone());
        let result = within_budget(Duration::from_millis(40), async {
            let permit = admit(slots.clone().acquire_owned().await.unwrap());
            spawn_blocking(move || {
                let _permit = permit;
                segment(&model, &[1])
            })
            .await
            .unwrap()
        })
        .await;
        assert!(result.is_none() || result.unwrap().is_err());
        assert_eq!(slots.available_permits(), 1);
        tokio::time::timeout(Duration::from_millis(100), async {
            while !done.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn cooperative_abort_releases_detached_admission_even_when_work_returns() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let (release, wait) = std::sync::mpsc::channel();
        let (done, finished) = tokio::sync::oneshot::channel();
        let result = within_budget(Duration::from_secs(1), async {
            let permit = admit(slots.clone().acquire_owned().await.unwrap());
            spawn_blocking(move || {
                let _permit = permit;
                let _ = wait.recv_timeout(Duration::from_secs(5));
                let _ = done.send(());
            });
            REQUEST_WORK.with(WorkControl::cancel);
            Err::<(), _>(Cancelled)
        })
        .await;
        let permits = slots.available_permits();
        release.send(()).unwrap();
        finished.await.unwrap();
        assert!(result.unwrap().is_err());
        assert_eq!(
            permits, 1,
            "cooperative expiry must release pending native admission"
        );
    }
    #[tokio::test]
    async fn remote_stages_share_one_deadline_and_expiry_does_not_start_fallback() {
        use axum::{Router, http::header, routing::post};
        use taphoa_recognition::wire;
        let app = Router::new().route(
            "/v1/segment",
            post(|| async {
                tokio::time::sleep(Duration::from_millis(70)).await;
                (
                    [(header::CONTENT_TYPE, wire::CONTENT_TYPE)],
                    wire::encode(&Vec::<Segment>::new()).unwrap(),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        struct Local(Arc<AtomicUsize>);
        impl Segmenter for Local {
            fn segment(&self, _: &[u8]) -> Result<Vec<Segment>, SegmentError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(vec![])
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let state = crate::AppState {
            segmenter: Some(Arc::new(Local(calls.clone()))),
            ..Default::default()
        };
        let remote = crate::remote_models::ready_remote(
            &url,
            "a-request-budget-token-at-least-32-characters",
            state,
        )
        .unwrap();
        let completed = Arc::new(AtomicUsize::new(0));
        let count = completed.clone();
        let result = within_budget(Duration::from_millis(110), async {
            spawn_blocking(move || {
                remote.segment(&[1]).unwrap();
                count.fetch_add(1, Ordering::SeqCst);
                remote.segment(&[1])
            })
            .await
            .unwrap()
        })
        .await;
        assert!(result.is_none() || result.unwrap().is_err());
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.abort();
    }
    #[tokio::test]
    async fn failed_remote_cannot_extend_budget_with_a_cold_local_fallback() {
        use taphoa_recognition::{Embedder, MockEmbedder};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (release, wait) = std::sync::mpsc::channel();
        let wait = std::sync::Mutex::new(wait);
        let started = Arc::new(AtomicBool::new(false));
        let loaded = started.clone();
        let mut local = crate::AppState::default();
        local.models.dino = Some(crate::model_holder::ModelHolder::new(
            "dinov2",
            Duration::ZERO,
            move || {
                loaded.store(true, Ordering::SeqCst);
                wait.lock().unwrap().recv_timeout(Duration::from_secs(2))?;
                Ok(Arc::new(MockEmbedder) as Arc<dyn Embedder>)
            },
        ));
        let remote = crate::remote_models::ready_remote(
            &url,
            "a-cold-fallback-token-at-least-32-characters",
            local,
        )
        .unwrap();
        let result = within_budget(Duration::from_millis(50), async {
            spawn_blocking(move || remote.embed(&[1])).await.unwrap()
        })
        .await;
        release.send(()).unwrap();
        assert!(started.load(Ordering::SeqCst));
        assert!(result.is_none() || result.unwrap().is_err());
    }
    #[tokio::test]
    async fn recognition_route_timeout_has_existing_retryable_503_shape() {
        use tower::ServiceExt;
        let app = axum::Router::new()
            .route(
                "/v1/recognition/scans",
                axum::routing::post(|| async { std::future::pending::<&'static str>().await }),
            )
            .layer(axum::middleware::from_fn(|request, next| {
                request_deadline_with_budget(request, next, Duration::from_millis(5))
            }));
        let response = app
            .oneshot(
                axum::http::Request::post("/v1/recognition/scans")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(response.headers()["retry-after"], "1");
    }
}
