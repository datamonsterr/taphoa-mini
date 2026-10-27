import { test } from 'node:test';
import assert from 'node:assert/strict';

test('client follows pagination and posts and patches JSON', async () => {
  const { createClient } = await import('../lib/client.mjs');
  const calls = [];
  const client = createClient({
    apiKey: 'test-key',
    projectId: '42',
    host: 'https://example.test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...init });
      return Response.json(
        init.method === 'GET'
          ? String(url).includes('page=2')
            ? { results: [{ id: 2 }], next: null }
            : {
                results: [{ id: 1 }],
                next: 'https://example.test/api/projects/42/dashboards/?page=2',
              }
          : JSON.parse(init.body),
      );
    },
  });
  assert.deepEqual(await client.listAll('dashboards/'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await client.post('dashboards/', { name: 'new' }), {
    name: 'new',
  });
  assert.deepEqual(await client.patch('dashboards/1/', { name: 'updated' }), {
    name: 'updated',
  });
  assert.equal(calls[2].headers.Authorization, 'Bearer test-key');
});

test('client never discloses authorization or key in HTTP and transport errors', async () => {
  const { createClient } = await import('../lib/client.mjs');
  for (const fetch of [
    async () =>
      new Response('Authorization: Bearer hidden-key; hidden-key', {
        status: 403,
      }),
    async () => {
      throw new Error('Authorization: Bearer hidden-key; hidden-key');
    },
  ]) {
    const client = createClient({
      apiKey: 'hidden-key',
      projectId: '42',
      host: 'https://example.test',
      fetch,
    });
    await assert.rejects(
      client.get('dashboards/'),
      (error) =>
        !error.message.includes('hidden-key') &&
        !/Authorization:\s*Bearer/i.test(error.message),
    );
  }
});

test('pagination cannot send credentials to a different origin', async () => {
  const { createClient } = await import('../lib/client.mjs');
  let calls = 0;
  const client = createClient({
    apiKey: 'secret',
    projectId: '42',
    host: 'https://example.test',
    fetch: async () => {
      calls++;
      return Response.json({ results: [], next: 'https://elsewhere.test/' });
    },
  });
  await assert.rejects(client.listAll('dashboards/'), /origin/);
  assert.equal(calls, 1);
});
