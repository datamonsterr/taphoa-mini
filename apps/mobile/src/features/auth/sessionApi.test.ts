import { isApiError } from '@/lib/api/errors';

import { fetchSessionMe, verifySessionPin } from './sessionApi';

type Token = jest.Mock<Promise<string | null>, [{ skipCache?: boolean }?]>;
const session = (token: string | null = 'token_a') => ({
  getToken: jest.fn(async (options?: { skipCache?: boolean }) =>
    options?.skipCache && token ? `${token}_fresh` : token,
  ) as Token,
});
const seen = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(([request]: [Request]) => request);
const me = { clerk_user_id: 'user_a', profile: null, memberships: [] };

let network: jest.SpyInstance;
beforeEach(() => {
  network = jest.spyOn(globalThis, 'fetch');
});
afterEach(() => jest.restoreAllMocks());

test('reads /v1/me with that session token and no store header', async () => {
  network.mockResolvedValue(Response.json(me));
  const mine = session();
  await expect(fetchSessionMe(mine)).resolves.toEqual(me);
  const [request] = seen(network);
  expect(request.method).toBe('GET');
  expect(new URL(request.url).pathname).toBe('/v1/me');
  expect(request.headers.get('authorization')).toBe('Bearer token_a');
  expect(request.headers.get('x-store-id')).toBeNull();
  expect(mine.getToken).toHaveBeenCalledTimes(1);
});

test('verifies a PIN with the target token, the target store and the PIN body', async () => {
  network.mockResolvedValue(new Response(null, { status: 204 }));
  await expect(
    verifySessionPin(session(), 'store_a', '4821'),
  ).resolves.toBeUndefined();
  const [request] = seen(network);
  expect(request.method).toBe('POST');
  expect(new URL(request.url).pathname).toBe('/v1/me/pin/verify');
  expect(request.headers.get('authorization')).toBe('Bearer token_a');
  expect(request.headers.get('x-store-id')).toBe('store_a');
  expect(await request.json()).toEqual({ pin: '4821' });
});

test('replays one 401 with a fresh token', async () => {
  network
    .mockResolvedValueOnce(
      Response.json(
        { error: 'expired', code: 'unauthorized' },
        { status: 401 },
      ),
    )
    .mockResolvedValueOnce(Response.json(me));
  const mine = session();
  await expect(fetchSessionMe(mine)).resolves.toEqual(me);
  expect(mine.getToken).toHaveBeenLastCalledWith({ skipCache: true });
  expect(seen(network)[1].headers.get('authorization')).toBe(
    'Bearer token_a_fresh',
  );
});

test('a second 401 reaches the caller as an ApiError', async () => {
  network.mockImplementation(async () =>
    Response.json({ error: 'expired', code: 'unauthorized' }, { status: 401 }),
  );
  const failure = await fetchSessionMe(session()).catch((error) => error);
  expect(isApiError(failure)).toBe(true);
  expect(failure).toMatchObject({ status: 401, code: 'unauthorized' });
  expect(network).toHaveBeenCalledTimes(2);
});

test('a wrong PIN is never replayed, so one entry costs one attempt', async () => {
  network.mockResolvedValue(
    Response.json({ error: 'bad', code: 'invalid_pin' }, { status: 401 }),
  );
  const mine = session();
  const failure = await verifySessionPin(mine, 'store_a', '0000').catch(
    (error) => error,
  );
  expect(failure).toMatchObject({ status: 401, code: 'invalid_pin' });
  expect(network).toHaveBeenCalledTimes(1);
  expect(mine.getToken).toHaveBeenCalledTimes(1);
});

test('a 401 stays when Clerk cannot mint a fresh token', async () => {
  network.mockResolvedValue(
    Response.json({ error: 'expired', code: 'unauthorized' }, { status: 401 }),
  );
  const mine = session();
  mine.getToken.mockResolvedValueOnce('token_a').mockResolvedValueOnce(null);
  await expect(fetchSessionMe(mine)).rejects.toMatchObject({ status: 401 });
  expect(network).toHaveBeenCalledTimes(1);
});

test('a 401 without a JSON body is treated like any other 401', async () => {
  network
    .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    .mockResolvedValueOnce(Response.json(me));
  await expect(fetchSessionMe(session())).resolves.toEqual(me);
  expect(network).toHaveBeenCalledTimes(2);
});

test('a session without a token never reaches the network', async () => {
  await expect(fetchSessionMe(session(null))).rejects.toMatchObject({
    status: 401,
    code: 'unauthorized',
  });
  expect(network).not.toHaveBeenCalled();
});

test('exposes the lockout wait from Retry-After', async () => {
  network.mockResolvedValue(
    Response.json(
      { error: 'rate limit exceeded', code: 'too_many_requests' },
      { status: 429, headers: { 'Retry-After': '120' } },
    ),
  );
  await expect(
    verifySessionPin(session(), 'store_a', '0000'),
  ).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
});
