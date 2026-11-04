/**
 * Disk-cache key of a product photo. Photo urls are presigned and change at every fetch, so the
 * url without its query string names the picture; the same photo then stays on the device between
 * sessions and offline.
 */
export const imageCacheKey = (uri: string): string => uri.split('?')[0]!;
