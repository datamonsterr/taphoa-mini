import { createAuthFetch } from './authFetch';
import { registerAuthBridge } from './clerkBridge';
import { getApiClient, setApiTransport } from './client';

test('a membership_required response invalidates me through the bridge', async () => {
  const invalidateMe = jest.fn();
  registerAuthBridge({
    getToken: async () => 'token',
    getStoreId: () => null,
    membershipRequired: invalidateMe,
  });
  const fetcher = createAuthFetch({
    baseUrl: 'http://api.test',
    fetch: (async () =>
      new Response('{"code":"membership_required"}', {
        status: 403,
      })) as typeof fetch,
  });
  expect((await fetcher('http://api.test/v1/store')).status).toBe(403);
  expect(invalidateMe).toHaveBeenCalledTimes(1);
});

describe('a forbidden answer inside a store', () => {
  const register = (invalidateMe = jest.fn()) => {
    registerAuthBridge({
      getToken: async () => 'token',
      getStoreId: () => 'store-a',
      membershipRequired: invalidateMe,
    });
    return invalidateMe;
  };
  const answer = (status: number, code: string) =>
    (async () =>
      Response.json({ error: 'nope', code }, { status })) as typeof fetch;

  test('re-reads me when the request carried X-Store-Id, so a removed person falls back', async () => {
    const invalidateMe = register();
    const fetcher = createAuthFetch({
      baseUrl: 'http://api.test',
      fetch: answer(403, 'forbidden'),
    });
    const response = await fetcher('http://api.test/v1/members', {
      headers: { 'X-Store-Id': 'store-a' },
    });
    expect(response.status).toBe(403);
    expect(invalidateMe).toHaveBeenCalledTimes(1);
  });

  test('does so for requests the shared client sends with the current store', async () => {
    const invalidateMe = register();
    setApiTransport(answer(403, 'forbidden'));
    const result = await getApiClient().raw.GET('/v1/members');
    expect(result.response.status).toBe(403);
    expect(invalidateMe).toHaveBeenCalledTimes(1);
  });

  test('also when the answer comes after the one 401 replay', async () => {
    const invalidateMe = register();
    const send = jest
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: 'unauthorized' }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ code: 'forbidden' }, { status: 403 }),
      );
    await createAuthFetch({ baseUrl: 'http://api.test', fetch: send })(
      'http://api.test/v1/members',
      { headers: { 'X-Store-Id': 'store-a' } },
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(invalidateMe).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['without X-Store-Id', 403, 'forbidden', {}],
    ['with another 403 code', 403, 'invalid_pin', { 'X-Store-Id': 'store-a' }],
    ['with a 404', 404, 'forbidden', { 'X-Store-Id': 'store-a' }],
  ])('leaves me alone %s', async (_label, status, code, headers) => {
    const invalidateMe = register();
    await createAuthFetch({
      baseUrl: 'http://api.test',
      fetch: answer(status, code),
    })('http://api.test/v1/members', { headers });
    expect(invalidateMe).not.toHaveBeenCalled();
  });
});
