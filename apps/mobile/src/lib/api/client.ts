import { createApiClient, type ApiClient } from '@taphoa/api-client';

import { createAuthFetch } from './authFetch';

/** Used when `EXPO_PUBLIC_API_URL` is unset: the backend of `docker compose up`. */
export const DEFAULT_API_URL = 'http://localhost:8080';

export const apiBaseUrl = (): string =>
  (process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');

let client: ApiClient | null = null;
let transport: typeof fetch | undefined;

function createClient(): ApiClient {
  const baseUrl = apiBaseUrl();
  return createApiClient({
    baseUrl,
    fetch: createAuthFetch({ baseUrl, fetch: transport }),
  });
}

/** Singleton API client: always the real backend at `EXPO_PUBLIC_API_URL`, signed with the session. */
export function getApiClient(): ApiClient {
  client ??= createClient();
  return client;
}

/** Swaps the transport under the auth layer (tests only) and drops the cached client. */
export function setApiTransport(next?: typeof fetch): void {
  transport = next;
  client = null;
}

/** Drops the cached client (tests; after changing env). */
export function resetApiClient(): void {
  client = null;
}
