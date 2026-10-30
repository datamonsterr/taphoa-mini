import { Image } from 'expo-image';
import { Platform } from 'react-native';

import type { Product } from '@/lib/api/types';
import { imageCacheKey } from '@/lib/imageCache';

/** Downloads in flight at once, so a first sync of a big catalog does not saturate the link. */
export const THUMBNAIL_CONCURRENCY = 4;
/** Most photos fetched per sync; the rest are cached when a tile shows them. */
export const THUMBNAIL_LIMIT = 200;

const done = new Set<string>();

/** Test hook: forget what was fetched. */
export function resetThumbnailPrefetch(): void {
  done.clear();
}

/**
 * Warms the disk cache with the first photo of each product, under the same cache key the tiles
 * use (`imageCacheKey`), so they render offline. `Image.prefetch` is not used: it keys by the full
 * presigned url, which never matches. `loadAsync` takes the `cacheKey` source field. Bounded: at
 * most `THUMBNAIL_LIMIT` photos per call, `THUMBNAIL_CONCURRENCY` at a time, each photo once per
 * session; failures are ignored (the tile fetches on demand).
 */
export async function prefetchThumbnails(
  products: readonly Product[],
): Promise<void> {
  // On web `loadAsync` is a cross-origin `fetch` the image host (no CORS headers) refuses, which
  // only logs errors; `<img>` loads there and the browser's own cache serves them.
  if (Platform.OS === 'web') return;
  const queue: { uri: string; cacheKey: string }[] = [];
  for (const product of products) {
    const uri = product.images?.[0]?.url;
    if (!uri) continue;
    const cacheKey = imageCacheKey(uri);
    if (done.has(cacheKey)) continue;
    done.add(cacheKey);
    queue.push({ uri, cacheKey });
    if (queue.length >= THUMBNAIL_LIMIT) break;
  }
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await Image.loadAsync(next);
      } catch {
        done.delete(next.cacheKey);
      }
    }
  };
  await Promise.all(Array.from({ length: THUMBNAIL_CONCURRENCY }, worker));
}
