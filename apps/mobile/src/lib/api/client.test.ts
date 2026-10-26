import { setAnalyticsBridge } from '../analyticsBridge';

import {
  apiBaseUrl,
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
  setAnalyticsBridge({
    getSessionId: () => session,
    captureException: () => {},
    isFeatureEnabled: () => undefined,
  });
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
    setAnalyticsBridge(null);
  }
});
