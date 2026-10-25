import { createMockFetch } from './fetch';
import { getMockDb } from './db';

const send = (path: string, body?: unknown, token = 'test-clerk-token') =>
  createMockFetch()(
    new Request(`http://api.test${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );

test('Clerk createStore and me expose membership, without any credential or recovery code', async () => {
  getMockDb().hasMembership = false;
  expect((await (await send('/v1/me')).json()).memberships).toEqual([]);
  const created = await send('/v1/stores', {
    store_name: 'Tạp hóa Mẹ',
    display_name: 'Mẹ',
  });
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(Object.keys(body).sort()).toEqual(['member', 'store']);
  expect(body.member.role).toBe('lead');
  const me = await (await send('/v1/me')).json();
  expect(me.memberships).toEqual([body]);
});
