import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../lib/client.mjs';

const definition = {
  name: 'Demo',
  description: 'Managed',
  query: { kind: 'InsightVizNode', source: { kind: 'TrendsQuery' } },
  dashboards: [8],
  tags: ['x6'],
};
function fixture(existing = [], { dryRun = false } = {}) {
  const calls = [];
  const client = createClient({
    apiKey: 'fake',
    projectId: '42',
    host: 'https://fake.test',
    fetch: async (url, options) => {
      calls.push({ url: String(url), ...options });
      if (options.method === 'GET')
        return Response.json({ results: existing, next: null });
      return Response.json({ id: 7, ...JSON.parse(options.body) });
    },
  });
  return { client, calls, dryRun };
}

test('insight dry-run plans creation without writes and updates preserve id', async () => {
  const { ensureInsight } = await import('../lib/sync.mjs');
  const empty = fixture([], { dryRun: true });
  assert.equal((await ensureInsight(empty, definition)).action, 'create');
  assert.ok(empty.calls.every((c) => c.method === 'GET'));
  const matching = fixture([
    {
      id: 7,
      ...definition,
      query: { source: { kind: 'TrendsQuery' }, kind: 'InsightVizNode' },
      ignored: true,
    },
  ]);
  assert.equal((await ensureInsight(matching, definition)).status, 'unchanged');
  assert.ok(matching.calls.every((c) => c.method === 'GET'));
  const changed = fixture([{ id: 7, ...definition, description: 'old' }]);
  assert.equal((await ensureInsight(changed, definition)).action, 'update');
  assert.match(changed.calls.at(-1).url, /insights\/7\/$/);
  assert.deepEqual(JSON.parse(changed.calls.at(-1).body), definition);
});

test('all resource helpers create, skip unchanged, and update through correct identifiers', async () => {
  const sync = await import('../lib/sync.mjs');
  for (const [helper, path, def] of [
    [
      'ensureDashboard',
      'dashboards/7/',
      { name: 'Dashboard', description: 'new', tags: ['x6'], pinned: true },
    ],
    [
      'ensureFeatureFlag',
      'feature_flags/7/',
      {
        key: 'assistant_enabled',
        name: 'Assistant',
        active: true,
        filters: { groups: [] },
      },
    ],
    [
      'ensurePlaylist',
      'session_recording_playlists/short/',
      {
        name: 'Playlist',
        description: 'new',
        type: 'filters',
        filters: { order: 'start_time' },
      },
    ],
    [
      'ensureLogView',
      'logs/views/short/',
      { name: 'Errors', filters: { severityLevels: ['error', 'fatal'] } },
    ],
  ]) {
    const empty = fixture([], { dryRun: true });
    assert.equal((await sync[helper](empty, def)).action, 'create');
    assert.ok(empty.calls.every((c) => c.method === 'GET'));
    assert.equal(
      (await sync[helper](fixture([{ id: 7, short_id: 'short', ...def }]), def))
        .status,
      'unchanged',
    );
    const changed = fixture([
      {
        id: 7,
        short_id: 'short',
        ...def,
        name: def.name,
        ...(def.key
          ? { active: false }
          : def.filters
            ? { filters: {} }
            : { description: 'old' }),
      },
    ]);
    assert.equal((await sync[helper](changed, def)).action, 'update');
    assert.ok(changed.calls.at(-1).url.endsWith(path));
  }
});

test('exact names prevent updating similarly named insights', async () => {
  const { ensureInsight } = await import('../lib/sync.mjs');
  assert.equal(
    (
      await ensureInsight(
        fixture([{ id: 7, ...definition, name: 'Demo extra' }], {
          dryRun: true,
        }),
        definition,
      )
    ).action,
    'create',
  );
});

test('group metadata warns until store exists and never creates a group type', async () => {
  const { ensureGroupTypeMetadata } = await import('../lib/sync.mjs');
  const def = {
    group_type: 'store',
    name_singular: 'Store',
    name_plural: 'Stores',
  };
  const empty = fixture();
  assert.equal((await ensureGroupTypeMetadata(empty, def)).action, 'skip');
  assert.ok(empty.calls.every((c) => c.method === 'GET'));
  const existing = fixture([{ group_type: 'store', group_type_index: 0 }]);
  assert.equal((await ensureGroupTypeMetadata(existing, def)).action, 'update');
  assert.deepEqual(JSON.parse(existing.calls.at(-1).body), [
    { group_type_index: 0, name_singular: 'Store', name_plural: 'Stores' },
  ]);
});

test('project settings resolve organization and respect dry-run and unchanged', async () => {
  const { ensureProjectSettings } = await import('../lib/sync.mjs');
  const settings = {
    session_recording_opt_in: true,
    autocapture_exceptions_opt_in: true,
    capture_console_log_opt_in: false,
  };
  const calls = [];
  const client = createClient({
    apiKey: 'fake',
    projectId: '42',
    host: 'https://fake.test',
    fetch: async (url, options) => {
      calls.push({ url: String(url), ...options });
      return Response.json({
        organization: 'org-1',
        ...JSON.parse(options.body || '{}'),
      });
    },
  });
  assert.equal(
    (
      await ensureProjectSettings(
        { client, dryRun: true, projectId: '42' },
        settings,
      )
    ).action,
    'update',
  );
  assert.ok(calls.every((c) => c.method === 'GET'));
  await ensureProjectSettings({ client, projectId: '42' }, settings);
  assert.ok(calls.at(-1).url.endsWith('/api/organizations/org-1/projects/42/'));
});

test('server-added nested defaults do not trigger redundant updates', async () => {
  const { ensureInsight } = await import('../lib/sync.mjs');
  const ctx = fixture([
    {
      id: 7,
      ...definition,
      query: {
        ...definition.query,
        source: { ...definition.query.source, version: 1 },
        full: true,
      },
    },
  ]);
  assert.equal((await ensureInsight(ctx, definition)).status, 'unchanged');
  assert.ok(ctx.calls.every((call) => call.method === 'GET'));
});
