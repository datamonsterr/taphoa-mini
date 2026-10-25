import { createAuthFetch } from './authFetch';
import { registerAuthBridge } from './clerkBridge';
import { getApiClient, setApiTransport } from './client';

const json = (status: number, body = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('retries a 401 exactly once with a fresh Clerk token and returns the second 401', async () => {
  const getToken = jest
    .fn()
    .mockResolvedValueOnce('cached')
    .mockResolvedValueOnce('fresh');
  registerAuthBridge({
    getToken,
    getStoreId: () => 'store-a',
    membershipRequired: jest.fn(),
  });
  const sent: Request[] = [];
  const transport = jest.fn(async (request: Request) => {
    sent.push(request);
    return json(401);
  });
  const fetcher = createAuthFetch({
    baseUrl: 'http://api.test',
    fetch: transport as typeof fetch,
  });
  const response = await fetcher('http://api.test/v1/sales', {
    method: 'POST',
    body: '{"lines":[]}',
  });
  expect(response.status).toBe(401);
  expect(sent).toHaveLength(2);
  expect(sent.map((r) => r.headers.get('authorization'))).toEqual([
    'Bearer cached',
    'Bearer fresh',
  ]);
  expect(await sent[1]!.text()).toBe('{"lines":[]}');
  expect(getToken.mock.calls).toEqual([[], [{ skipCache: true }]]);
});

test('sets X-Store-Id from the current store on the shared API client', async () => {
  registerAuthBridge({
    getToken: async () => 'clerk',
    getStoreId: () => 'store-b',
    membershipRequired: jest.fn(),
  });
  const transport = jest.fn(async (_request: Request) =>
    json(200, { items: [] }),
  );
  setApiTransport(transport as typeof fetch);
  await getApiClient().raw.GET('/v1/members');
  expect(
    (transport.mock.calls[0]![0] as Request).headers.get('X-Store-Id'),
  ).toBe('store-b');
});

test.each(['/healthz', '/readyz'])(
  'health endpoint %s stays public',
  async (path) => {
    const token = jest.fn();
    registerAuthBridge({
      getToken: token,
      getStoreId: () => null,
      membershipRequired: jest.fn(),
    });
    const send = jest.fn(async (_r: Request) => json(200));
    await createAuthFetch({
      baseUrl: 'http://api.test',
      fetch: send as typeof fetch,
    })(`http://api.test${path}`);
    expect(token).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0].headers.get('authorization')).toBeNull();
  },
);
test('a successful fresh token retries once and preserves headers', async () => {
  registerAuthBridge({
    getToken: jest
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new'),
    getStoreId: () => null,
    membershipRequired: jest.fn(),
  });
  const send = jest
    .fn()
    .mockResolvedValueOnce(json(401))
    .mockResolvedValueOnce(json(200));
  const fetcher = createAuthFetch({ baseUrl: 'http://api.test', fetch: send });
  const response = await fetcher(
    new Request('http://api.test/v1/me', {
      headers: { 'X-Store-Id': 'selected' },
    }),
  );
  expect(response.status).toBe(200);
  expect(send.mock.calls[1]![0].headers.get('X-Store-Id')).toBe('selected');
});
test('a wrong PIN is never replayed and does not count as a second attempt', async () => {
  const token = jest.fn().mockResolvedValue('token');
  registerAuthBridge({
    getToken: token,
    getStoreId: () => null,
    membershipRequired: jest.fn(),
  });
  const send = jest.fn(async () => json(401, { code: 'invalid_pin' }));
  const response = await createAuthFetch({
    baseUrl: 'http://api.test',
    fetch: send,
  })('http://api.test/v1/me/pin/verify');
  expect(response.status).toBe(401);
  expect(send).toHaveBeenCalledTimes(1);
  expect(token).toHaveBeenCalledTimes(1);
});
test('signed-out requests remove stale authorization and are not retried', async () => {
  registerAuthBridge({
    getToken: async () => null,
    getStoreId: () => null,
    membershipRequired: jest.fn(),
  });
  const send = jest.fn(async (_r: Request) => json(401));
  await createAuthFetch({
    baseUrl: 'http://api.test',
    fetch: send as typeof fetch,
  })('http://api.test/v1/me', { headers: { authorization: 'Bearer stale' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0].headers.get('authorization')).toBeNull();
});
test('if Clerk has no fresh token the original 401 is returned', async () => {
  registerAuthBridge({
    getToken: jest
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce(null),
    getStoreId: () => null,
    membershipRequired: jest.fn(),
  });
  const send = jest.fn(async () => json(401));
  expect(
    (
      await createAuthFetch({ baseUrl: 'http://api.test', fetch: send })(
        'http://api.test/v1/me',
      )
    ).status,
  ).toBe(401);
  expect(send).toHaveBeenCalledTimes(1);
});
test('a 403 other than membership_required is returned without invalidation', async () => {
  const invalidate = jest.fn();
  registerAuthBridge({
    getToken: async () => 'token',
    getStoreId: () => null,
    membershipRequired: invalidate,
  });
  const send = jest.fn(async () => new Response('not JSON', { status: 403 }));
  expect(
    (
      await createAuthFetch({ baseUrl: 'http://api.test', fetch: send })(
        'http://api.test/v1/store',
      )
    ).status,
  ).toBe(403);
  expect(invalidate).not.toHaveBeenCalled();
});
