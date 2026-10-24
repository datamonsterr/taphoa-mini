//! Encoder output LRU cache with TTL.
//! Caches `Arc<ImageEncoding>` and optionally the decoded `Arc<RgbImage>` by `(store_id, image_id)`.

use image::RgbImage;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use taphoa_recognition::ImageEncoding;
use uuid::Uuid;

pub const DEFAULT_CACHE_CAPACITY: usize = 16;
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes

struct CacheEntry {
    store_id: Uuid,
    image_id: Uuid,
    encoding: Arc<ImageEncoding>,
    photo: Option<Arc<RgbImage>>,
    expires_at: Instant,
}

pub struct EncodingCache {
    capacity: usize,
    ttl: Duration,
    entries: Mutex<Vec<CacheEntry>>,
}

impl Default for EncodingCache {
    fn default() -> Self {
        Self::new(DEFAULT_CACHE_CAPACITY, DEFAULT_CACHE_TTL)
    }
}

impl EncodingCache {
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            capacity: capacity.max(1),
            ttl,
            entries: Mutex::new(Vec::with_capacity(capacity)),
        }
    }

    /// Retrieve an encoding and optional cached decoded photo.
    /// Returns None if missing or expired.
    /// Updates LRU order on hit (moves to back as most recently used).
    pub fn get(
        &self,
        store_id: Uuid,
        image_id: Uuid,
    ) -> Option<(Arc<ImageEncoding>, Option<Arc<RgbImage>>)> {
        let mut entries = self.entries.lock().ok()?;
        let now = Instant::now();

        let pos = entries
            .iter()
            .position(|e| e.store_id == store_id && e.image_id == image_id)?;

        if entries[pos].expires_at < now {
            entries.remove(pos);
            return None;
        }

        let entry = entries.remove(pos);
        let result = (Arc::clone(&entry.encoding), entry.photo.clone());
        entries.push(entry);
        Some(result)
    }

    /// Insert or update an encoding in the cache.
    pub fn insert(
        &self,
        store_id: Uuid,
        image_id: Uuid,
        encoding: Arc<ImageEncoding>,
        photo: Option<Arc<RgbImage>>,
    ) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let now = Instant::now();
        let expires_at = now + self.ttl;

        // Remove expired entries first
        entries.retain(|e| e.expires_at >= now);

        if let Some(pos) = entries
            .iter()
            .position(|e| e.store_id == store_id && e.image_id == image_id)
        {
            entries.remove(pos);
        } else if entries.len() >= self.capacity {
            entries.remove(0);
        }

        entries.push(CacheEntry {
            store_id,
            image_id,
            encoding,
            photo,
            expires_at,
        });
    }

    pub fn len(&self) -> usize {
        let Ok(mut entries) = self.entries.lock() else {
            return 0;
        };
        let now = Instant::now();
        entries.retain(|e| e.expires_at >= now);
        entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use taphoa_recognition::{MockPointSegmenter, PointSegmenter};

    fn mock_encoding() -> Arc<ImageEncoding> {
        MockPointSegmenter::default().encode(&[]).unwrap()
    }

    #[test]
    fn test_cache_insert_and_get() {
        let cache = EncodingCache::new(2, Duration::from_secs(60));
        let store = Uuid::new_v4();
        let img1 = Uuid::new_v4();
        let enc1 = mock_encoding();

        assert!(cache.get(store, img1).is_none());
        cache.insert(store, img1, enc1.clone(), None);

        let retrieved = cache.get(store, img1);
        assert!(retrieved.is_some());
        let (got_enc, got_photo) = retrieved.unwrap();
        assert_eq!(got_enc.width, 1600);
        assert!(got_photo.is_none());
    }

    #[test]
    fn test_cache_lru_eviction() {
        let cache = EncodingCache::new(2, Duration::from_secs(60));
        let store = Uuid::new_v4();
        let img1 = Uuid::new_v4();
        let img2 = Uuid::new_v4();
        let img3 = Uuid::new_v4();

        cache.insert(store, img1, mock_encoding(), None);
        cache.insert(store, img2, mock_encoding(), None);
        assert_eq!(cache.len(), 2);

        // Access img1 so img2 becomes the least recently used
        assert!(cache.get(store, img1).is_some());

        // Insert img3, which should evict img2
        cache.insert(store, img3, mock_encoding(), None);
        assert_eq!(cache.len(), 2);

        assert!(cache.get(store, img1).is_some());
        assert!(
            cache.get(store, img2).is_none(),
            "img2 should have been evicted"
        );
        assert!(cache.get(store, img3).is_some());
    }

    #[test]
    fn test_cache_store_isolation() {
        let cache = EncodingCache::new(4, Duration::from_secs(60));
        let store1 = Uuid::new_v4();
        let store2 = Uuid::new_v4();
        let img = Uuid::new_v4();

        cache.insert(store1, img, mock_encoding(), None);
        assert!(cache.get(store1, img).is_some());
        assert!(
            cache.get(store2, img).is_none(),
            "different store must not see encoding"
        );
    }

    #[test]
    fn test_cache_ttl_expiration() {
        let cache = EncodingCache::new(2, Duration::from_millis(1));
        let store = Uuid::new_v4();
        let img = Uuid::new_v4();

        cache.insert(store, img, mock_encoding(), None);
        std::thread::sleep(Duration::from_millis(10));

        assert!(
            cache.get(store, img).is_none(),
            "expired entry must return None"
        );
        assert_eq!(cache.len(), 0);
    }
}
