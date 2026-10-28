import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dashboards } from './definitions/index.mjs';
import { llmDashboards } from './llm/index.mjs';
import { traceFilters } from './llm/trace-filters.mjs';
import { createClient } from './lib/client.mjs';
import { loadSecrets } from './lib/secrets.mjs';

export function scopeQuery(
  query,
  { environment, days, onlyStore, excludeStore } = {},
) {
  if (environment !== undefined && !/^[a-z][a-z0-9_-]*$/.test(environment))
    throw new Error('Invalid environment');
  if (days !== undefined && (!Number.isSafeInteger(days) || days <= 0))
    throw new Error('days must be a positive integer');
  const source = structuredClone(query.source ?? query);
  if (onlyStore && excludeStore)
    throw new Error('Choose only-store or exclude-store');
  const store = onlyStore ?? excludeStore;
  if (
    store !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      store,
    )
  )
    throw new Error('store must be a UUID');
  const predicate = (field) =>
    onlyStore
      ? `${field} = '${store}'`
      : `coalesce(${field}, '') != '${store}'`;
  if (source.kind === 'HogQLQuery') {
    const field = /FROM logs\b/.test(source.query)
      ? "resource_attributes['deployment.environment.name']"
      : 'properties.environment';
    source.query = source.query
      .replaceAll(
        '{{environment}}',
        environment ? `${field} = '${environment}'` : '1 = 1',
      )
      .replaceAll('{{days}}', String(days ?? 30));
    if (store) {
      const logs = /FROM logs\b/.test(source.query);
      const table = logs ? 'logs' : 'events';
      const scans =
        source.query.match(
          new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, 'gi'),
        ) ?? [];
      const supported = new RegExp(`\\bFROM\\s+${table}\\s+WHERE\\b`, 'gi');
      if (
        !scans.length ||
        scans.length !== (source.query.match(supported) ?? []).length
      )
        throw new Error('Unsupported store filter SQL shape');
      source.query = source.query.replace(
        supported,
        `FROM ${table} WHERE (${predicate(logs ? "attributes['taphoa.store.id']" : 'properties.$groups.store')}) AND`,
      );
    }
  } else {
    if (days !== undefined)
      source.dateRange = { ...source.dateRange, date_from: `-${days}d` };
    if (environment) {
      const entities = [
        ...(source.series ?? []),
        ...[
          source.retentionFilter?.targetEntity,
          source.retentionFilter?.returningEntity,
        ].filter(Boolean),
      ];
      for (const entity of entities)
        entity.properties = [
          ...(entity.properties ?? []),
          {
            type: 'event',
            key: 'environment',
            value: environment,
            operator: 'exact',
          },
        ];
    }
    if (store) {
      const entities = [
        ...(source.series ?? []),
        ...[
          source.retentionFilter?.targetEntity,
          source.retentionFilter?.returningEntity,
        ].filter(Boolean),
      ];
      if (!entities.length)
        throw new Error('Unsupported store filter query shape');
      for (const entity of entities)
        entity.properties = [
          ...(entity.properties ?? []),
          { type: 'hogql', key: predicate('properties.$groups.store') },
        ];
    }
  }
  return source;
}
export function hasData(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  // HogQL tables return arrays of cells. Grouped rows themselves prove input exists.
  if (Array.isArray(results[0]))
    return results.some((row) => row.some((cell) => cell !== null));
  const measured = (value) => {
    if (!value || typeof value !== 'object') return false;
    if (
      Array.isArray(value.data) &&
      value.data.some((number) => typeof number === 'number' && number > 0)
    )
      return true;
    if (typeof value.count === 'number' && value.count > 0) return true;
    // BoldNumber trends report one aggregated value instead of a series.
    if (
      typeof value.aggregated_value === 'number' &&
      value.aggregated_value > 0
    )
      return true;
    return Object.values(value).some(
      (child) =>
        typeof child === 'object' &&
        (Array.isArray(child) ? child.some(measured) : measured(child)),
    );
  };
  return results.some(measured);
}
export async function verify({
  client,
  environment,
  days = 7,
  allowEmpty,
  only,
  onlyStore,
  excludeStore,
}) {
  if (only && !['dashboards', 'llm'].includes(only))
    throw new Error('--only must be one of: dashboards, llm');
  const selectedDashboards = [
    ...(!only || only === 'dashboards' ? dashboards : []),
    ...(!only || only === 'llm'
      ? [...llmDashboards, { name: 'Assistant traces', insights: traceFilters }]
      : []),
  ];
  const insights = [];
  for (const dashboard of selectedDashboards)
    for (const insight of dashboard.insights) {
      const row = {
        dashboard: dashboard.name,
        insight: insight.name,
        rows: 0,
        ok: false,
        data: false,
      };
      try {
        const query = scopeQuery(insight.query, {
          environment: insight.scope === 'all' ? undefined : environment,
          days,
          ...(insight.scope === 'all' ? {} : { onlyStore, excludeStore }),
        });
        const result = await client.post('query/', {
          query,
          name: insight.name,
          refresh: 'force_blocking',
        });
        row.rows = result.results?.length ?? 0;
        row.ok = hasData(result.results);
        if (
          !row.ok &&
          query.kind === 'TrendsQuery' &&
          query.trendsFilter?.formula
        ) {
          // A valid 0% needs denominator evidence, since PostHog zero-fills empty series.
          const evidence = structuredClone(query);
          delete evidence.trendsFilter.formula;
          evidence.series = [evidence.series.at(-1)];
          const denominator = await client.post('query/', {
            query: evidence,
            refresh: 'force_blocking',
          });
          row.ok = hasData(denominator.results);
        }
      } catch (error) {
        row.error = error.message;
      }
      row.data = row.ok;
      const llm =
        dashboard.name === 'Assistant traces' ||
        llmDashboards.includes(dashboard);
      // Charts that are empty by design (no backend errors, producer epic not shipped yet).
      if (!row.ok && !row.error && (llm || allowEmpty?.test(insight.name))) {
        row.ok = true;
        row.note = 'empty (allowed)';
      }
      insights.push(row);
    }
  return {
    ok: insights.every((row) => row.ok),
    environment,
    days,
    ...(onlyStore ? { onlyStore } : {}),
    ...(excludeStore ? { excludeStore } : {}),
    insights,
  };
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      environment: { type: 'string' },
      days: { type: 'string', default: '7' },
      json: { type: 'boolean', default: false },
      only: { type: 'string' },
      'allow-empty': { type: 'string' },
      'only-store': { type: 'string' },
      'exclude-store': { type: 'string' },
    },
  });
  if (!values.environment) throw new Error('Required: --environment <name>');
  const days = Number(values.days);
  scopeQuery(
    { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$screen' }] },
    {
      environment: values.environment,
      days,
      onlyStore: values['only-store'],
      excludeStore: values['exclude-store'],
    },
  );
  const config = loadSecrets();
  const result = await verify({
    client: createClient(config),
    environment: values.environment,
    days,
    only: values.only,
    onlyStore: values['only-store'],
    excludeStore: values['exclude-store'],
    allowEmpty: values['allow-empty']
      ? new RegExp(values['allow-empty'])
      : undefined,
  });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('dashboard | insight | rows | data | ok');
    for (const row of result.insights)
      console.log(
        `${row.dashboard} | ${row.insight} | ${row.rows} | ${row.data ? 'yes' : 'no'} | ${row.ok ? 'yes' : 'no'}${row.note ? ` (${row.note})` : ''}${row.error ? ` (${row.error})` : ''}`,
      );
  }
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
