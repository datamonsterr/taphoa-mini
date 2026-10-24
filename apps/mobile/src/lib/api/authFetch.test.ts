import { useSessionStore, type Session } from '@/stores/session';
import { testSession } from '@/test/session';

import { createAuthFetch, isPublicPath } from './authFetch';

const BASE = 'http://api.test';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const rotated = (n: number): Session => ({
  ...testSession(),
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
});

type Call = { path: string; auth: string | null; body: string };

/** A scripted backend: `/v1/products` answers 200 for the current access token and 401 otherwise. */
function backend(options: {
  validToken: () => string;
  refresh: () => Promise<Response> | Response;
}) {
  const calls: Call[] = [];
  const transport = jest.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    calls.push({
      path,
      auth: request.headers.get('authorization'),
      body: await request.clone().text(),
    });
    if (path === '/v1/auth/refresh') return options.refresh();
    if (path === '/v1/stores') return json(201, { ok: true });
    return request.headers.get('authorization') ===
      `Bearer ${options.validToken()}`
      ? json(200, { items: [] })
      : json(401, { error: 'expired', code: 'unauthorized' });
  });
  return { calls, transport: transport as unknown as typeof fetch };
}

const refreshOk = (n: number) => () => json(200, rotated(n));

beforeEach(() => {
  useSessionStore.setState({ session: rotated(0), hydrated: true });
});

test('knows which paths run without a session', () => {
  for (const path of [
    '/healthz',
    '/v1/stores',
    '/v1/auth/join',
    '/v1/auth/recover',
    '/v1/auth/refresh',
  ]) {
    expect(isPublicPath(path)).toBe(true);
  }
  expect(isPublicPath('/v1/auth/logout')).toBe(false);
  expect(isPublicPath('/v1/products')).toBe(false);
});

test('attaches the bearer access token', async () => {
  const { calls, transport } = backend({
    validToken: () => 'access-0',
    refresh: refreshOk(1),
  });
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
  const response = await authFetch(`${BASE}/v1/products`);
  expect(response.status).toBe(200);
  expect(calls).toEqual([
    { path: '/v1/products', auth: 'Bearer access-0', body: '' },
  ]);
});

test('public routes carry no token and never refresh', async () => {
  const { calls, transport } = backend({
    validToken: () => 'access-0',
    refresh: refreshOk(1),
  });
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
  await authFetch(`${BASE}/v1/stores`, { method: 'POST', body: '{}' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.auth).toBeNull();
});

test('a 401 rotates the refresh token once, stores the pair and replays the request', async () => {
  let valid = 'access-1';
  const { calls, transport } = backend({
    validToken: () => valid,
    refresh: () => {
      valid = 'access-1';
      return json(200, rotated(1));
    },
  });
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
  const response = await authFetch(`${BASE}/v1/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"Sting"}',
  });
  expect(response.status).toBe(200);
  expect(calls.map((c) => [c.path, c.auth])).toEqual([
    ['/v1/products', 'Bearer access-0'],
    ['/v1/auth/refresh', null],
    ['/v1/products', 'Bearer access-1'],
  ]);
  expect(JSON.parse(calls[1]!.body)).toEqual({ refresh_token: 'refresh-0' });
  // The replay still carries the original body.
  expect(calls[2]!.body).toBe('{"name":"Sting"}');
  expect(useSessionStore.getState().session).toMatchObject({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
  });
});

test('concurrent 401s share one refresh (single flight)', async () => {
  let valid = 'access-1';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { calls, transport } = backend({
    validToken: () => valid,
    refresh: async () => {
      await gate;
      valid = 'access-1';
      return json(200, rotated(1));
    },
  });
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
  const all = Promise.all([
    authFetch(`${BASE}/v1/products`),
    authFetch(`${BASE}/v1/sales`),
    authFetch(`${BASE}/v1/members`),
  ]);
  // Let every request hit its 401 before the refresh answers.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const responses = await all;
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(calls.filter((c) => c.path === '/v1/auth/refresh')).toHaveLength(1);
  const retries = calls.filter((c) => c.auth === 'Bearer access-1');
  expect(retries).toHaveLength(3);
});

test('a request that failed with a token another request already replaced is just replayed', async () => {
  let valid = 'access-1';
  let rotate!: () => void;
  const gate = new Promise<void>((resolve) => (rotate = resolve));
  const { calls, transport } = backend({
    validToken: () => valid,
    refresh: refreshOk(1),
  });
  // The slow request leaves with access-0 and only learns about the 401 after the pair rotated.
  const slow = jest.fn(async (input: RequestInfo | URL) => {
    const response = await (transport as jest.Mock)(input);
    if (new URL((input as Request).url).pathname === '/v1/sales') await gate;
    return response;
  }) as unknown as typeof fetch;
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: slow });
  const pending = authFetch(`${BASE}/v1/sales`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  valid = 'access-1';
  useSessionStore.setState({ session: rotated(1) });
  rotate();
  expect((await pending).status).toBe(200);
  expect(calls.some((c) => c.path === '/v1/auth/refresh')).toBe(false);
});

test('a refused refresh clears the session and returns the original 401', async () => {
  const { calls, transport } = backend({
    validToken: () => 'never',
    refresh: () => json(401, { error: 'revoked', code: 'unauthorized' }),
  });
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
  const response = await authFetch(`${BASE}/v1/products`);
  expect(response.status).toBe(401);
  expect(useSessionStore.getState().session).toBeNull();
  expect(calls.map((c) => c.path)).toEqual([
    '/v1/products',
    '/v1/auth/refresh',
  ]);
});

test('an unreachable or failing refresh keeps the session', async () => {
  for (const refresh of [
    () => json(503, { error: 'down' }),
    () => {
      throw new TypeError('network down');
    },
  ]) {
    useSessionStore.setState({ session: rotated(0) });
    const { transport } = backend({ validToken: () => 'never', refresh });
    const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
    expect((await authFetch(`${BASE}/v1/products`)).status).toBe(401);
    expect(useSessionStore.getState().session?.access_token).toBe('access-0');
  }
});

test('without a session a 401 is returned as is', async () => {
  useSessionStore.setState({ session: null });
  const { calls, transport } = backend({
    validToken: () => 'x',
    refresh: refreshOk(1),
  });
  const authFetch = createAuthFetch({ baseUrl: BASE, fetch: transport });
  expect((await authFetch(`${BASE}/v1/products`)).status).toBe(401);
  expect(calls).toHaveLength(1);
});

test('a wrong PIN is a 401 that is neither refreshed nor replayed', async () => {
  const { calls, transport } = backend({
    validToken: () => 'access-0',
    refresh: refreshOk(1),
  });
  const wrongPin = jest.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    if (new URL(request.url).pathname === '/v1/auth/switch') {
      return json(401, {
        error: 'missing or invalid PIN',
        code: 'invalid_pin',
      });
    }
    return (
      transport as unknown as (i: RequestInfo | URL) => Promise<Response>
    )(input);
  });
  const authFetch = createAuthFetch({
    baseUrl: BASE,
    fetch: wrongPin as unknown as typeof fetch,
  });
  const response = await authFetch(`${BASE}/v1/auth/switch`, {
    method: 'POST',
    body: '{}',
  });
  expect(response.status).toBe(401);
  expect(wrongPin).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([]);
  expect(useSessionStore.getState().session?.access_token).toBe('access-0');
});
