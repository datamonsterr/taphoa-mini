import { createMockFetch } from './fetch';
import { resetMockDb } from './db';
import { MOCK_ROUTES } from './routes';

const base = 'http://mock.local';
const mockFetch = createMockFetch();
beforeEach(resetMockDb);

const send = (method: string, path: string, body?: unknown) =>
  mockFetch(
    new Request(base + path, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
    }),
  );

test('unknown path -> 404 Error body', async () => {
  const res = await send('GET', '/v1/nope');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ code: 'not_found' });
});

test('known path, wrong method -> 405', async () => {
  const res = await send('DELETE', '/v1/store');
  expect(res.status).toBe(405);
  expect(await res.json()).toMatchObject({ code: 'method_not_allowed' });
});

test('invalid JSON body -> 400 validation_failed', async () => {
  const res = await send('POST', '/v1/sales', '{not json');
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'validation_failed' });
});

test('empty body on a body-optional route is treated as {}', async () => {
  const res = await send('GET', '/v1/alerts');
  const [alert] = ((await res.json()) as { items: { id: string }[] }).items;
  const accept = await send('POST', `/v1/alerts/${alert!.id}/accept`);
  expect(accept.status).toBe(200);
});

test('path params are url-decoded and extra slash tolerated', async () => {
  const res = await send('GET', '/v1/products/not%20a%20product/');
  expect(res.status).toBe(404);
});

test('plain strings and URLs are accepted like fetch', async () => {
  const res = await mockFetch(`${base}/healthz`);
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('unexpected handler failures become 500 Error bodies', async () => {
  const route = MOCK_ROUTES.find((r) => r.path === '/healthz')!;
  const original = route.handler;
  route.handler = () => {
    throw new Error('boom');
  };
  const failing = await send('GET', '/healthz');
  expect(failing.status).toBe(500);
  expect(await failing.json()).toEqual({
    error: 'boom',
    code: 'internal_error',
  });
  route.handler = () => {
    throw 'not an error';
  };
  expect(await (await send('GET', '/healthz')).json()).toMatchObject({
    error: 'Mock failure',
  });
  route.handler = original;
});

test('default latency is 0 under test; explicit latencyMs is honoured', async () => {
  jest.useFakeTimers();
  const slow = createMockFetch({ latencyMs: [200, 200] });
  let done = false;
  const pending = slow(`${base}/healthz`).then(() => {
    done = true;
  });
  await jest.advanceTimersByTimeAsync(199);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(2);
  await pending;
  expect(done).toBe(true);
  jest.useRealTimers();
});

test('outside tests the latency defaults to 120-350 ms', async () => {
  const env = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = 'development';
  jest.useFakeTimers();
  const dev = createMockFetch();
  (process.env as Record<string, string>).NODE_ENV = env!;
  let done = false;
  const pending = dev(`${base}/healthz`).then(() => {
    done = true;
  });
  await jest.advanceTimersByTimeAsync(119);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(232);
  await pending;
  expect(done).toBe(true);
  jest.useRealTimers();
});
