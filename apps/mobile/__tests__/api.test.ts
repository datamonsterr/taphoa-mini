import { getHealth } from '../src/lib/api';

const originalFetch = global.fetch;
const originalApiUrl = process.env.EXPO_PUBLIC_API_URL;
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test/';
  global.fetch = fetchMock;
  fetchMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiUrl === undefined) {
    delete process.env.EXPO_PUBLIC_API_URL;
  } else {
    process.env.EXPO_PUBLIC_API_URL = originalApiUrl;
  }
});

test('fetches /healthz and parses the health response', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'ok' }),
  } as Response);

  await expect(getHealth()).resolves.toEqual({ status: 'ok' });
  expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/healthz');
});

test('rejects an unsuccessful HTTP response', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
  await expect(getHealth()).rejects.toThrow('Health request failed: 503');
});

test.each([null, {}, { status: 'down' }])(
  'rejects malformed health data: %p',
  async (data) => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => data,
    } as Response);
    await expect(getHealth()).rejects.toThrow('Invalid health response');
  },
);

test('requires an explicitly configured API URL', async () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  await expect(getHealth()).rejects.toThrow(
    'EXPO_PUBLIC_API_URL is not configured',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
