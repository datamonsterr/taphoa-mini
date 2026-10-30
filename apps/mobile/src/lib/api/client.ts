import { createApiClient, type ApiClient } from '@taphoa/api-client';

import { analyticsSessionId } from '@/lib/analyticsBridge';

import { createAuthFetch } from './authFetch';
import { currentStoreId } from './clerkBridge';

/** Used when `EXPO_PUBLIC_API_URL` is unset in development: the backend of `docker compose up`. */
export const DEFAULT_API_URL = 'http://localhost:8080';

/** A release build has no backend URL; it must not fall back to localhost on a phone. */
export class ApiNotConfiguredError extends Error {
  constructor() {
    super('EXPO_PUBLIC_API_URL is not set in this build');
    this.name = 'ApiNotConfiguredError';
  }
}

/** True when requests have a backend: the URL is set, or this is a development build. */
export const apiConfigured = (): boolean =>
  !!process.env.EXPO_PUBLIC_API_URL || __DEV__;

export const apiBaseUrl = (): string => {
  const url =
    process.env.EXPO_PUBLIC_API_URL || (__DEV__ ? DEFAULT_API_URL : '');
  if (!url) throw new ApiNotConfiguredError();
  return url.replace(/\/+$/, '');
};

let client: ApiClient | null = null;
let transport: typeof fetch | undefined;

function createClient(): ApiClient {
  const baseUrl = apiBaseUrl();
  return createApiClient({
    baseUrl,
    getSessionId: analyticsSessionId,
    getStoreId: currentStoreId,
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
