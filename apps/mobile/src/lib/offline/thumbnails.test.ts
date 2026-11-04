import { Image } from 'expo-image';
import { Platform } from 'react-native';

import type { Product } from '@/lib/api/types';

import {
  prefetchThumbnails,
  resetThumbnailPrefetch,
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_LIMIT,
} from './thumbnails';

jest.mock('expo-image', () => ({ Image: { loadAsync: jest.fn() } }));

const withPhoto = (id: string, url?: string) =>
  ({
    id,
    images: url ? [{ url }] : [],
  }) as unknown as Product;

const load = jest.mocked(Image.loadAsync);

beforeEach(() => {
  resetThumbnailPrefetch();
  load.mockReset();
  load.mockResolvedValue(undefined as never);
});

test('fetches the first photo under the tile cache key (url without query)', async () => {
  await prefetchThumbnails([
    withPhoto('a', 'https://cdn/a.jpg?sig=1'),
    withPhoto('b'),
  ]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith({
    uri: 'https://cdn/a.jpg?sig=1',
    cacheKey: 'https://cdn/a.jpg',
  });
});

test('fetches a photo once per session even when its signature changes; retries after failure', async () => {
  await prefetchThumbnails([withPhoto('a', 'https://cdn/a.jpg?sig=1')]);
  await prefetchThumbnails([withPhoto('a', 'https://cdn/a.jpg?sig=2')]);
  expect(load).toHaveBeenCalledTimes(1);
  resetThumbnailPrefetch();
  load.mockClear();
  load.mockRejectedValueOnce(new Error('offline'));
  await prefetchThumbnails([withPhoto('a', 'https://cdn/a.jpg')]);
  await prefetchThumbnails([withPhoto('a', 'https://cdn/a.jpg')]);
  expect(load).toHaveBeenCalledTimes(2);
});

test('does nothing on web, where loadAsync is a blocked cross-origin fetch', async () => {
  const original = Platform.OS;
  Platform.OS = 'web';
  try {
    await prefetchThumbnails([withPhoto('a', 'https://cdn/a.jpg')]);
  } finally {
    Platform.OS = original;
  }
  expect(load).not.toHaveBeenCalled();
});

test('caps concurrency and the number of photos per call', async () => {
  let active = 0;
  let peak = 0;
  load.mockImplementation(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return undefined as never;
  });
  const many = Array.from({ length: THUMBNAIL_LIMIT + 50 }, (_, i) =>
    withPhoto(`p${i}`, `https://cdn/${i}.jpg`),
  );
  await prefetchThumbnails(many);
  expect(load).toHaveBeenCalledTimes(THUMBNAIL_LIMIT);
  expect(peak).toBe(THUMBNAIL_CONCURRENCY);
});
