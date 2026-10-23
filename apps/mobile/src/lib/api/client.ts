import { createApiClient, type ApiClient } from '@taphoa/api-client';

import { createMockFetch } from '@/lib/mock/fetch';

let client: ApiClient | null = null;

function createClient(): ApiClient {
  if (process.env.EXPO_PUBLIC_API_MODE === 'live') {
    const baseUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!baseUrl) {
      throw new Error('EXPO_PUBLIC_API_URL is not configured');
    }
    return createApiClient({ baseUrl });
  }
  return createApiClient({
    baseUrl: 'http://mock.local',
    fetch: createMockFetch(),
  });
}

/** Singleton API client: the in-app mock by default, the real API when `EXPO_PUBLIC_API_MODE=live`. */
export function getApiClient(): ApiClient {
  client ??= createClient();
  return client;
}

/** Drops the cached client (tests; after changing env). */
export function resetApiClient(): void {
  client = null;
}
