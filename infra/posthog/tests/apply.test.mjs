import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createClient } from '../lib/client.mjs';

test('empty dashboard dry-run yields 42 create operations and only GET requests', async () => {
  const { apply } = await import('../apply.mjs');
  const calls = [];
  const lines = [];
  const client = createClient({
    apiKey: 'fake',
    projectId: '42',
    host: 'https://fake.test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...init });
      return Response.json({ results: [], next: null });
    },
  });
  const operations = await apply({
    client,
    projectId: '42',
    dryRun: true,
    only: 'dashboards',
    print: (line) => lines.push(line),
  });
  assert.equal(operations.length, 42);
  assert.ok(operations.every((op) => op.action === 'create'));
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(
    lines.includes('create insight "Product overview · Revenue per day"'),
  );
  assert.ok(
    operations
      .filter((op) => op.type === 'insight')
      .every((op) => !JSON.stringify(op.payload.query).includes('{{')),
  );
});

test('applying twice against a fake API preserves ids and reports every managed object unchanged', async () => {
  const { apply } = await import('../apply.mjs');
  const store = new Map();
  const writes = [];
  const client = createClient({
    apiKey: 'fake',
    projectId: '42',
    host: 'https://fake.test',
    fetch: async (url, init) => {
      const path = new URL(url).pathname.replace('/api/projects/42/', '');
      if (init.method === 'GET')
        return Response.json({
          results: [...store.values()].filter((item) => item.path === path),
          next: null,
        });
      assert.equal(init.method, 'POST');
      const item = { ...JSON.parse(init.body), id: store.size + 1, path };
      writes.push(item);
      store.set(item.id, item);
      return Response.json(item);
    },
  });
  await apply({ client, projectId: '42', only: 'dashboards', print: () => {} });
  const lines = [];
  const result = await apply({
    client,
    projectId: '42',
    only: 'dashboards',
    print: (line) => lines.push(line),
  });
  assert.equal(writes.length, 42);
  assert.ok(result.every((op) => op.status === 'unchanged'));
  assert.ok(lines.every((line) => line.startsWith('unchanged ')));
});

test('offline CLI works without secrets or network and rejects unsafe or unknown options', async () => {
  const run = (args) =>
    spawnSync(process.execPath, ['infra/posthog/apply.mjs', ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: '/nonexistent',
        POSTHOG_PERSONAL_API_KEY: '',
        POSTHOG_PROJECT_ID: '',
      },
    });
  const result = run(['--dry-run', '--offline']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /create dashboard "Reliability"/);
  assert.match(result.stdout, /skip group "store"/);
  assert.equal(run(['--offline']).status, 1);
  assert.equal(run(['--dry-run', '--offline', '--only', 'bad']).status, 1);
  const flags = run(['--dry-run', '--offline', '--only', 'flags']);
  assert.equal(flags.status, 0);
  assert.match(flags.stdout, /create flag "assistant_enabled"/);
  assert.ok(!flags.stdout.includes('dashboard'));
});
