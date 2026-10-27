import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  dashboards,
  featureFlags,
  playlists,
  logViews,
  groupTypes,
  projectSettings,
} from './definitions/index.mjs';
import { createClient } from './lib/client.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import {
  ensureDashboard,
  ensureInsight,
  ensureFeatureFlag,
  ensurePlaylist,
  ensureLogView,
  ensureGroupTypeMetadata,
  ensureProjectSettings,
} from './lib/sync.mjs';
import { scopeQuery } from './verify.mjs';

const categories = [
  'dashboards',
  'flags',
  'playlists',
  'logs',
  'groups',
  'settings',
];
export async function apply({
  client,
  projectId,
  dryRun = false,
  only,
  print = console.log,
}) {
  if (only && !categories.includes(only))
    throw new Error(`--only must be one of: ${categories.join(', ')}`);
  const context = { client, projectId, dryRun };
  const operations = [];
  async function run(type, name, ensure, definition) {
    const operation = await ensure(context, definition);
    operations.push({ type, name, ...operation });
    print(
      `${operation.status ?? operation.action} ${type} ${JSON.stringify(name)}${operation.warning ? ` (${operation.warning})` : ''}`,
    );
    return operation;
  }
  if (!only || only === 'dashboards')
    for (const { insights, ...dashboard } of dashboards) {
      const result = await run(
        'dashboard',
        dashboard.name,
        ensureDashboard,
        dashboard,
      );
      for (const { events: _events, ...insight } of insights) {
        const source = scopeQuery(insight.query);
        const query = { ...insight.query, source };
        await run('insight', insight.name, ensureInsight, {
          ...insight,
          query,
          dashboards: [result.object.id],
        });
      }
    }
  for (const [category, type, definitions, ensure] of [
    ['flags', 'flag', featureFlags, ensureFeatureFlag],
    ['playlists', 'playlist', playlists, ensurePlaylist],
    ['logs', 'log view', logViews, ensureLogView],
    ['groups', 'group', groupTypes, ensureGroupTypeMetadata],
  ])
    if (!only || only === category)
      for (const definition of definitions)
        await run(
          type,
          definition.key ?? definition.group_type ?? definition.name,
          ensure,
          definition,
        );
  if (!only || only === 'settings')
    await run('settings', 'project', ensureProjectSettings, projectSettings);
  return operations;
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      only: { type: 'string' },
    },
  });
  if (values.offline && !values['dry-run'])
    throw new Error('--offline requires --dry-run');
  // Offline deliberately bypasses credentials and supplies empty read fixtures only.
  const config = values.offline ? { projectId: 'offline' } : loadSecrets();
  const client = values.offline
    ? {
        listAll: async () => [],
        get: async () => ({ organization: 'offline' }),
      }
    : createClient(config);
  return apply({
    client,
    projectId: config.projectId,
    dryRun: values['dry-run'],
    only: values.only,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
