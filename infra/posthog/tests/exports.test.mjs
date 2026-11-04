import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboards } from '../definitions/index.mjs';
import { llmDashboards } from '../llm/index.mjs';
import { exportDashboards } from '../export-dashboards.mjs';
import { createClient } from '../lib/client.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
const saved = [...dashboards, ...llmDashboards].map((d, i) => ({
  name: d.name,
  id: i + 1,
}));

test('exports every product and LLM dashboard, polls, validates PNG and records IDs', async () => {
  const calls = [];
  const files = new Map();
  const result = await exportDashboards({
    client: {
      listAll: async (path) => {
        assert.equal(path, 'dashboards/');
        return saved;
      },
      post: async (path, body) => {
        calls.push({ path, body });
        return { id: body.dashboard, has_content: false };
      },
      get: async (path) => {
        assert.match(path, /^exports\/\d+\/$/);
        return { has_content: true };
      },
      download: async (path) => {
        assert.match(path, /^exports\/\d+\/content\/$/);
        return png;
      },
    },
    sleep: async () => {},
    now: () => new Date('2026-10-29T01:00:00Z'),
    save: async (file, bytes) => files.set(file, bytes),
  });
  assert.equal(calls.length, 12);
  assert.ok(
    calls.every(
      (call) =>
        call.path === 'exports/' && call.body.export_format === 'image/png',
    ),
  );
  assert.equal(files.size, 13);
  assert.equal(result.dashboards.length, 12);
  assert.match(result.scope, /all environments/);
  assert.ok(
    [...files.keys()].every((file) =>
      file.startsWith('2026-10-29T01-00-00-000Z-'),
    ),
  );
});

test('rejects missing/ambiguous dashboards before writing any exports', async () => {
  for (const data of [saved.slice(1), [...saved, saved[0]]]) {
    await assert.rejects(
      exportDashboards({
        client: {
          listAll: async () => data,
          post: () => assert.fail('no write'),
        },
      }),
      /Expected one dashboard/,
    );
  }
});

test('export failures, bounded polling and non-PNG bytes fail without saving a false image', async () => {
  for (const [asset, bytes, pattern] of [
    [{ id: 1, exception: 'failed' }, png, /failed/],
    [{ id: 1, has_content: false }, png, /timed out/],
    [{ id: 1, has_content: true }, Buffer.from('<html>'), /not PNG/],
  ]) {
    await assert.rejects(
      exportDashboards({
        client: {
          listAll: async () => saved,
          post: async () => asset,
          get: async () => asset,
          download: async () => bytes,
        },
        maxPolls: 1,
        sleep: async () => {},
        save: () => assert.fail('must not save'),
      }),
      pattern,
    );
  }
});

test('download follows a signed HTTPS redirect with no Authorization header', async () => {
  const calls = [];
  const client = createClient({
    apiKey: 'secret',
    projectId: '42',
    host: 'https://posthog.test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: 'https://storage.test/file.png?signed=private',
            },
          })
        : new Response(png);
    },
  });
  assert.deepEqual(
    Buffer.from(await client.download('exports/1/content/')),
    png,
  );
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[1].init.headers, undefined);
});

test('download rejects HTTP/credential redirects and hides signed URLs on errors', async () => {
  for (const target of [
    'http://storage.test/file',
    'https://user:pass@storage.test/file',
    'https://storage.test/file?signed=private',
  ]) {
    let count = 0;
    const client = createClient({
      apiKey: 'secret',
      projectId: '42',
      host: 'https://posthog.test',
      fetch: async () => {
        if (count++ === 0)
          return new Response(null, {
            status: 302,
            headers: { location: target },
          });
        throw new Error(
          'failed https://storage.test/file?signed=private secret',
        );
      },
    });
    await assert.rejects(
      client.download('exports/1/content/'),
      (error) =>
        !error.message.includes('secret') && !error.message.includes('private'),
    );
  }
});
