import type { PostHog } from 'posthog-react-native';

import { setAnalyticsClient } from '../analyticsBridge';

import {
  ApiNotConfiguredError,
  apiBaseUrl,
  apiConfigured,
  DEFAULT_API_URL,
  getApiClient,
  resetApiClient,
  setApiTransport,
} from './client';

const ok = () =>
  new Response('{"status":"ok"}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_MODE;
  delete process.env.EXPO_PUBLIC_API_URL;
  resetApiClient();
});

test('returns a singleton until reset', () => {
  const first = getApiClient();
  expect(getApiClient()).toBe(first);
  resetApiClient();
  expect(getApiClient()).not.toBe(first);
});

test('defaults to the local backend', async () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  const transport = jest.fn().mockImplementation(async () => ok());
  setApiTransport(transport);
  expect(apiBaseUrl()).toBe(DEFAULT_API_URL);
  expect(DEFAULT_API_URL).toBe('http://localhost:8080');
  await getApiClient().getHealth();
  expect((transport.mock.calls[0]![0] as Request).url).toBe(
    'http://localhost:8080/healthz',
  );
});

test('uses EXPO_PUBLIC_API_URL and ignores a trailing slash', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test/';
  const transport = jest.fn().mockImplementation(async () => ok());
  setApiTransport(transport);
  await getApiClient().getHealth();
  expect((transport.mock.calls[0]![0] as Request).url).toBe(
    'https://api.example.test/healthz',
  );
});

test('there is no mock mode: EXPO_PUBLIC_API_MODE changes nothing', async () => {
  process.env.EXPO_PUBLIC_API_MODE = 'mock';
  const transport = jest.fn().mockImplementation(async () => ok());
  setApiTransport(transport);
  await getApiClient().getHealth();
  expect((transport.mock.calls[0]![0] as Request).url).toBe(
    'http://localhost:8080/healthz',
  );
});

test('without an injected transport the global fetch is used', async () => {
  setApiTransport(undefined);
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => ok());
  await getApiClient().getHealth();
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test('reads the analytics session for each request from the bridge', async () => {
  let session: string | null = 'replay-1';
  setAnalyticsClient({ getSessionId: () => session } as unknown as PostHog);
  const transport = jest.fn().mockImplementation(async () => ok());
  setApiTransport(transport);
  try {
    await getApiClient().getHealth();
    expect(
      (transport.mock.calls[0][0] as Request).headers.get(
        'X-POSTHOG-SESSION-ID',
      ),
    ).toBe('replay-1');
    session = null;
    await getApiClient().getHealth();
    expect(
      (transport.mock.calls[1][0] as Request).headers.get(
        'X-POSTHOG-SESSION-ID',
      ),
    ).toBeNull();
  } finally {
    setAnalyticsClient(null);
  }
});

describe('release build (not __DEV__)', () => {
  const g = globalThis as unknown as { __DEV__: boolean };
  const dev = g.__DEV__;
  beforeEach(() => {
    g.__DEV__ = false;
  });
  afterEach(() => {
    g.__DEV__ = dev;
  });

  test('never falls back to localhost without EXPO_PUBLIC_API_URL', () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    expect(apiConfigured()).toBe(false);
    expect(() => apiBaseUrl()).toThrow(ApiNotConfiguredError);
    expect(() => getApiClient()).toThrow(ApiNotConfiguredError);
  });

  test('uses EXPO_PUBLIC_API_URL when it is set', () => {
    process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test/';
    expect(apiConfigured()).toBe(true);
    expect(apiBaseUrl()).toBe('https://api.example.test');
  });
});

test('development keeps the localhost fallback', () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  expect(apiConfigured()).toBe(true);
  expect(apiBaseUrl()).toBe(DEFAULT_API_URL);
});
