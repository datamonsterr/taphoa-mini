import { createAuthFetch } from './authFetch';
import { registerAuthBridge } from './clerkBridge';

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
