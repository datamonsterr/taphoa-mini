use async_trait::async_trait;
use axum::http::HeaderMap;
use redis::aio::ConnectionManager;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Auth rate limits; `Default` is the contract (docs/api/openapi.yaml, architecture 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimits {
    pub store_create_per_hour: u32,
    pub join_per_hour: u32,
    pub recover_per_10min: u32,
    /// Wrong PINs before the member is locked for 5 minutes.
    pub pin_attempts: u32,
}
impl Default for RateLimits {
    fn default() -> Self {
        Self {
            store_create_per_hour: 10,
            join_per_hour: 10,
            recover_per_10min: 5,
            pin_attempts: 5,
        }
    }
}

/// Where the rate-limit client address comes from. Anything a client can set
/// freely is never trusted: the default is the socket peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClientIpSource {
    #[default]
    Peer,
    /// `X-Real-IP` as set by the trusted edge; falls back to the peer.
    XRealIp,
    /// The `hops`-th entry from the RIGHT of `X-Forwarded-For` (1 = appended by the
    /// closest trusted proxy); falls back to the peer when absent or unparseable.
    ForwardedFor { hops: usize },
}
impl ClientIpSource {
    pub fn parse(source: &str, hops: usize) -> anyhow::Result<Self> {
        match source.trim().to_ascii_lowercase().as_str() {
            "peer" => Ok(Self::Peer),
            "x-real-ip" => Ok(Self::XRealIp),
            "x-forwarded-for" if hops >= 1 => Ok(Self::ForwardedFor { hops }),
            "x-forwarded-for" => anyhow::bail!("TRUSTED_PROXY_HOPS must be at least 1"),
            _ => anyhow::bail!("CLIENT_IP_SOURCE must be peer, x-real-ip or x-forwarded-for"),
        }
    }
    pub fn resolve(&self, headers: &HeaderMap, peer: Option<IpAddr>) -> String {
        let from_header = match self {
            Self::Peer => None,
            Self::XRealIp => headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<IpAddr>().ok()),
            Self::ForwardedFor { hops } => {
                let entries: Vec<&str> = headers
                    .get_all("x-forwarded-for")
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .flat_map(|v| v.split(','))
                    .collect();
                entries
                    .len()
                    .checked_sub(*hops)
                    .and_then(|i| entries[i].trim().parse::<IpAddr>().ok())
            }
        };
        from_header
            .or(peer)
            .map_or_else(|| "unknown".into(), |ip| ip.to_string())
    }
}

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
pub struct RedisRateLimiter {
    connection: ConnectionManager,
    server_address: String,
}
impl RedisRateLimiter {
    pub fn new(connection: ConnectionManager, url: &str) -> Self {
        Self {
            connection,
            server_address: crate::telemetry::server_address(url),
        }
    }
}
#[async_trait]
impl RateLimiter for RedisRateLimiter {
    async fn reset(&self, key: &str) -> anyhow::Result<()> {
        crate::telemetry::client("redis DEL", &self.server_address, async {
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(&mut self.connection.clone())
                .await?;
            Ok(())
        })
        .await
    }
    async fn check(&self, key: &str, limit: u32) -> anyhow::Result<RateDecision> {
        crate::telemetry::client("redis EVAL", &self.server_address, async {
            let (count, ttl): (u64, i64) = redis::Script::new(
                "return {tonumber(redis.call('GET',KEYS[1]) or '0'),redis.call('PTTL',KEYS[1])}",
            )
            .key(key)
            .invoke_async(&mut self.connection.clone())
            .await?;
            Ok(RateDecision {
                allowed: count <= u64::from(limit),
                retry_after_secs: if count <= u64::from(limit) {
                    0
                } else {
                    (ttl.max(1) as u64).div_ceil(1000)
                },
            })
        })
        .await
    }
    async fn hit(&self, key: &str, limit: u32, window: Duration) -> anyhow::Result<RateDecision> {
        let work = async {
            let millis = window_millis(window)?;
            // Lua makes the increment and expiry inseparable, including under concurrency.
            let script = redis::Script::new(
                "local count = redis.call('INCR', KEYS[1]); redis.call('PEXPIRE', KEYS[1], ARGV[1], 'NX'); return {count, redis.call('PTTL', KEYS[1])}",
            );
            let (count, ttl): (u64, i64) = script
                .key(key)
                .arg(millis)
                .invoke_async(&mut self.connection.clone())
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
        };
        crate::telemetry::client("redis EVAL", &self.server_address, work).await
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
        let url = std::env::var("REDIS_URL").unwrap();
        let client = redis::Client::open(url.as_str()).unwrap();
        let connection = ConnectionManager::new(client).await.unwrap();
        let limiter = std::sync::Arc::new(RedisRateLimiter::new(connection, &url));
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

#[cfg(test)]
mod client_ip_tests {
    use super::*;
    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.append(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        map
    }
    const PEER: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 9)));
    #[test]
    fn peer_mode_ignores_every_header() {
        let spoofed = headers(&[("x-forwarded-for", "1.1.1.1"), ("x-real-ip", "2.2.2.2")]);
        assert_eq!(ClientIpSource::Peer.resolve(&spoofed, PEER), "10.0.0.9");
        assert_eq!(ClientIpSource::Peer.resolve(&spoofed, None), "unknown");
    }
    #[test]
    fn forwarded_for_uses_the_proxy_appended_entry_not_the_spoofed_one() {
        let source = ClientIpSource::ForwardedFor { hops: 1 };
        let spoofed = headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.7")]);
        assert_eq!(source.resolve(&spoofed, PEER), "203.0.113.7");
        let other = headers(&[("x-forwarded-for", "7.7.7.7, 203.0.113.7")]);
        assert_eq!(source.resolve(&other, PEER), "203.0.113.7");
        let two_hops = ClientIpSource::ForwardedFor { hops: 2 };
        let chain = headers(&[("x-forwarded-for", "6.6.6.6, 198.51.100.4, 203.0.113.7")]);
        assert_eq!(two_hops.resolve(&chain, PEER), "198.51.100.4");
        // Separate header lines are one list; a spoofed first line cannot shadow the last.
        let lines = headers(&[
            ("x-forwarded-for", "6.6.6.6"),
            ("x-forwarded-for", "203.0.113.7"),
        ]);
        assert_eq!(source.resolve(&lines, PEER), "203.0.113.7");
    }
    #[test]
    fn missing_short_or_garbage_values_fall_back_to_peer() {
        let source = ClientIpSource::ForwardedFor { hops: 2 };
        assert_eq!(
            source.resolve(&headers(&[("x-forwarded-for", "203.0.113.7")]), PEER),
            "10.0.0.9"
        );
        assert_eq!(
            source.resolve(&headers(&[("x-forwarded-for", "junk, more")]), PEER),
            "10.0.0.9"
        );
        assert_eq!(
            ClientIpSource::XRealIp.resolve(&headers(&[("x-real-ip", "nope")]), PEER),
            "10.0.0.9"
        );
        assert_eq!(
            ClientIpSource::XRealIp.resolve(&headers(&[("x-real-ip", "203.0.113.7")]), PEER),
            "203.0.113.7"
        );
    }
    #[test]
    fn parse_validates() {
        assert_eq!(
            ClientIpSource::parse("peer", 1).unwrap(),
            ClientIpSource::Peer
        );
        assert_eq!(
            ClientIpSource::parse("X-Forwarded-For", 2).unwrap(),
            ClientIpSource::ForwardedFor { hops: 2 }
        );
        assert!(ClientIpSource::parse("x-forwarded-for", 0).is_err());
        assert!(ClientIpSource::parse("anything", 1).is_err());
    }
}
