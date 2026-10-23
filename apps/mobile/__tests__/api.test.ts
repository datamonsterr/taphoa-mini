import { getHealth, resetApiClient } from '../src/lib/api';

const originalFetch = global.fetch;
const originalEnv = {
  mode: process.env.EXPO_PUBLIC_API_MODE,
  url: process.env.EXPO_PUBLIC_API_URL,
};
const fetchMock = jest.fn<Promise<Response>, [Request]>();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function restoreEnv(
  key: 'EXPO_PUBLIC_API_MODE' | 'EXPO_PUBLIC_API_URL',
  value?: string,
) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_MODE = 'live';
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test/';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  resetApiClient();
});

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv('EXPO_PUBLIC_API_MODE', originalEnv.mode);
  restoreEnv('EXPO_PUBLIC_API_URL', originalEnv.url);
  resetApiClient();
});

test('fetches /healthz and parses the health response', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

  await expect(getHealth()).resolves.toEqual({ status: 'ok' });
  expect(fetchMock.mock.calls[0]![0].url).toBe(
    'https://api.example.test/healthz',
  );
});

test('rejects an unsuccessful HTTP response', async () => {
  fetchMock.mockResolvedValue(jsonResponse({}, 503));
  await expect(getHealth()).rejects.toThrow('Health request failed: 503');
});

test.each([null, {}, { status: 'down' }])(
  'rejects malformed health data: %p',
  async (data) => {
    fetchMock.mockResolvedValue(jsonResponse(data));
    await expect(getHealth()).rejects.toThrow('Invalid health response');
  },
);

test('live mode requires an explicitly configured API URL', async () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  await expect(getHealth()).rejects.toThrow(
    'EXPO_PUBLIC_API_URL is not configured',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test('mock mode (default) answers without touching the network', async () => {
  delete process.env.EXPO_PUBLIC_API_MODE;
  delete process.env.EXPO_PUBLIC_API_URL;
  resetApiClient();
  await expect(getHealth()).resolves.toEqual({ status: 'ok' });
  expect(fetchMock).not.toHaveBeenCalled();
});
