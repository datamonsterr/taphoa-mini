//! Cooperative cancellation between native model calls. A running ORT call is
//! allowed to return; no further prompt, crop batch or decoder step starts.
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("inference cancelled or deadline exceeded")]
pub struct Cancelled;

#[derive(Debug, Clone)]
pub struct WorkControl {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}
impl WorkControl {
    pub fn new(deadline: Instant) -> Self {
        Self {
            deadline,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }
}
pub(crate) fn checkpoint(control: Option<&WorkControl>) -> Result<(), Cancelled> {
    control.map_or(Ok(()), WorkControl::check)
}
thread_local! { static CURRENT: std::cell::RefCell<Option<WorkControl>> = const { std::cell::RefCell::new(None) }; }
/// The API propagates its request control to synchronous adapters and their fallback.
pub fn current() -> Option<WorkControl> {
    CURRENT.with(|slot| slot.borrow().clone())
}
pub fn scope<T>(control: Option<WorkControl>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<WorkControl>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|slot| slot.replace(self.0.take()));
        }
    }
    let _restore = Restore(CURRENT.with(|slot| slot.replace(control)));
    work()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_expired_deadline_are_shared() {
        let control = WorkControl::new(Instant::now() + std::time::Duration::from_secs(10));
        let clone = control.clone();
        assert!(clone.check().is_ok());
        control.cancel();
        assert!(clone.check().is_err());
        assert!(WorkControl::new(Instant::now()).check().is_err());
        assert!(checkpoint(None).is_ok());
    }
}
