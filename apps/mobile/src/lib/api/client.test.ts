import { getApiClient, resetApiClient } from './client';

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

test('serves the in-app mock unless EXPO_PUBLIC_API_MODE is live', async () => {
  const { data, response } = await getApiClient().raw.GET('/v1/store');
  expect(response.status).toBe(200);
  expect(data?.name).toBe('Tạp hóa Cô Ba');
});

test('live mode uses the configured base URL', async () => {
  process.env.EXPO_PUBLIC_API_MODE = 'live';
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test';
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{"status":"ok"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await getApiClient().getHealth();
  expect((fetchSpy.mock.calls[0]![0] as Request).url).toBe(
    'https://api.example.test/healthz',
  );
  fetchSpy.mockRestore();
});
