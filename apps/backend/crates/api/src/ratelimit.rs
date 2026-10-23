use async_trait::async_trait;
use redis::aio::ConnectionManager;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateDecision {
    pub allowed: bool,
    pub retry_after_secs: u64,
}
#[async_trait]
pub trait RateLimiter: Send + Sync {
    async fn check(&self, key: &str, limit: u32) -> anyhow::Result<RateDecision>;
    async fn reset(&self, key: &str) -> anyhow::Result<()>;
    async fn hit(
        &self,
        key: &str,
        limit: u32,
        window: Duration,
    ) -> Result<RateDecision, anyhow::Error>;
}
pub struct RedisRateLimiter(pub ConnectionManager);
#[async_trait]
impl RateLimiter for RedisRateLimiter {
    async fn reset(&self, key: &str) -> anyhow::Result<()> {
        redis::cmd("DEL")
            .arg(key)
            .query_async::<i64>(&mut self.0.clone())
            .await?;
        Ok(())
    }
    async fn check(&self, key: &str, limit: u32) -> anyhow::Result<RateDecision> {
        let (count, ttl): (u64, i64) = redis::Script::new(
            "return {tonumber(redis.call('GET',KEYS[1]) or '0'),redis.call('PTTL',KEYS[1])}",
        )
        .key(key)
        .invoke_async(&mut self.0.clone())
        .await?;
        Ok(RateDecision {
            allowed: count <= u64::from(limit),
            retry_after_secs: if count <= u64::from(limit) {
                0
            } else {
                (ttl.max(1) as u64).div_ceil(1000)
            },
        })
    }
    async fn hit(&self, key: &str, limit: u32, window: Duration) -> anyhow::Result<RateDecision> {
        let millis = window_millis(window)?;
        // Lua makes the increment and expiry inseparable, including under concurrency.
        let script = redis::Script::new(
            "local count = redis.call('INCR', KEYS[1]); redis.call('PEXPIRE', KEYS[1], ARGV[1], 'NX'); return {count, redis.call('PTTL', KEYS[1])}",
        );
        let (count, ttl): (u64, i64) = script
            .key(key)
            .arg(millis)
            .invoke_async(&mut self.0.clone())
            .await?;
        let allowed = count <= u64::from(limit);
        Ok(RateDecision {
            allowed,
            retry_after_secs: if allowed {
                0
            } else {
                u64::try_from(ttl.max(1))?.div_ceil(1000)
            },
        })
    }
}
fn window_millis(window: Duration) -> anyhow::Result<u64> {
    anyhow::ensure!(!window.is_zero(), "rate limit window must be positive");
    let millis = u64::try_from(window.as_millis().max(1))?;
    anyhow::ensure!(millis <= i64::MAX as u64, "rate limit window too large");
    Ok(millis)
}
#[derive(Default)]
pub struct MemoryRateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
}
struct Bucket {
    count: u64,
    expires: Instant,
}
#[async_trait]
impl RateLimiter for MemoryRateLimiter {
    async fn reset(&self, key: &str) -> anyhow::Result<()> {
        self.buckets
            .lock()
            .map_err(|_| anyhow::anyhow!("rate limiter lock poisoned"))?
            .remove(key);
        Ok(())
    }
    async fn check(&self, key: &str, limit: u32) -> anyhow::Result<RateDecision> {
        let buckets = self
            .buckets
            .lock()
            .map_err(|_| anyhow::anyhow!("rate limiter lock poisoned"))?;
        let now = Instant::now();
        let blocked = buckets
            .get(key)
            .filter(|b| b.expires > now && b.count > u64::from(limit));
        Ok(RateDecision {
            allowed: blocked.is_none(),
            retry_after_secs: blocked
                .map(|b| {
                    b.expires
                        .saturating_duration_since(now)
                        .as_secs()
                        .saturating_add(1)
                })
                .unwrap_or(0),
        })
    }
    async fn hit(&self, key: &str, limit: u32, window: Duration) -> anyhow::Result<RateDecision> {
        let millis = window_millis(window)?;
        let window = Duration::from_millis(millis);
        let now = Instant::now();
        let expires = now
            .checked_add(window)
            .ok_or_else(|| anyhow::anyhow!("rate limit window too large"))?;
        let mut buckets = self
            .buckets
            .lock()
            .map_err(|_| anyhow::anyhow!("rate limiter lock poisoned"))?;
        buckets.retain(|_, bucket| bucket.expires > now);
        let bucket = buckets
            .entry(key.into())
            .or_insert(Bucket { count: 0, expires });
        bucket.count = bucket.count.saturating_add(1);
        let allowed = bucket.count <= u64::from(limit);
        Ok(RateDecision {
            allowed,
            retry_after_secs: if allowed {
                0
            } else {
                bucket
                    .expires
                    .saturating_duration_since(now)
                    .as_nanos()
                    .div_ceil(1_000_000_000) as u64
            },
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn isolated_fixed_windows_expire() {
        let limiter = MemoryRateLimiter::default();
        let window = Duration::from_millis(20);
        assert!(limiter.hit("a", 1, window).await.unwrap().allowed);
        let denied = limiter.hit("a", 1, window).await.unwrap();
        assert!(!denied.allowed);
        assert_eq!(denied.retry_after_secs, 1);
        assert!(limiter.hit("b", 1, window).await.unwrap().allowed);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(limiter.hit("a", 1, window).await.unwrap().allowed);
        assert!(limiter.hit("a", 1, Duration::ZERO).await.is_err());
        assert!(!limiter.hit("zero", 0, window).await.unwrap().allowed);
    }
    #[tokio::test]
    async fn concurrent_hits_do_not_exceed_limit() {
        let limiter = std::sync::Arc::new(MemoryRateLimiter::default());
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let limiter = limiter.clone();
            tasks.push(tokio::spawn(async move {
                limiter
                    .hit("shared", 5, Duration::from_secs(60))
                    .await
                    .unwrap()
                    .allowed
            }));
        }
        let mut allowed = 0;
        for task in tasks {
            allowed += usize::from(task.await.unwrap());
        }
        assert_eq!(allowed, 5);
    }
    #[tokio::test]
    #[ignore = "requires REDIS_URL"]
    async fn redis_atomic_window() {
        let client = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
        let connection = ConnectionManager::new(client).await.unwrap();
        let limiter = std::sync::Arc::new(RedisRateLimiter(connection));
        let key = format!("test:rate:{}", uuid::Uuid::new_v4());
        let mut tasks = Vec::new();
        for _ in 0..12 {
            let limiter = limiter.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                limiter
                    .hit(&key, 3, Duration::from_millis(100))
                    .await
                    .unwrap()
            }));
        }
        let mut allowed = 0;
        for task in tasks {
            let result = task.await.unwrap();
            allowed += usize::from(result.allowed);
            if !result.allowed {
                assert_eq!(result.retry_after_secs, 1);
            }
        }
        assert_eq!(allowed, 3);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            limiter
                .hit(&key, 3, Duration::from_millis(100))
                .await
                .unwrap()
                .allowed
        );
    }
}
