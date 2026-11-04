import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createClient } from './lib/client.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import { verify, scopeQuery } from './verify.mjs';

// AI custom properties can be strings; normalize before combining with false.
export const nonSynthetic =
  "NOT coalesce(toBool(properties.synthetic), false) AND distinct_id != 'synthetic-x6-validation'";

// This transformer supports only the managed definitions, not arbitrary user SQL.
// Apply at each events/ai_events scan (including subqueries), before aggregation/funnel math.
export function excludeSynthetic(source) {
  const query = structuredClone(source);
  if (query.kind === 'HogQLQuery') {
    if (
      /FROM logs\b/i.test(query.query) &&
      !/\b(?:events|ai_events)\b/i.test(query.query)
    )
      return query; // Logs are a separate signal; event synthetic flags do not apply.
    const scans =
      query.query.match(
        /\b(?:FROM|JOIN)\s+(?:events|posthog\.ai_events)\b/gi,
      ) ?? [];
    const supported =
      query.query.match(/\bFROM\s+(?:events|posthog\.ai_events)\s+WHERE\b/gi) ??
      [];
    if (!scans.length || scans.length !== supported.length)
      throw new Error(
        'Unsupported event SQL shape; refusing an unfiltered query',
      );
    query.query = query.query.replace(
      /\bFROM\s+(events|posthog\.ai_events)\s+WHERE\b/gi,
      (_scan, table) => `FROM ${table} WHERE (${nonSynthetic}) AND`,
    );
  } else {
    const entities = [
      ...(query.series ?? []),
      ...[
        query.retentionFilter?.targetEntity,
        query.retentionFilter?.returningEntity,
      ].filter(Boolean),
    ];
    if (!entities.length) throw new Error('Unsupported native query shape');
    for (const entity of entities)
      entity.properties = [
        ...(entity.properties ?? []),
        { type: 'hogql', key: nonSynthetic },
      ];
  }
  return query;
}

export async function verifyNonsynthetic({ client, ...options }) {
  const result = await verify({
    ...options,
    client: {
      post(path, body) {
        if (path !== 'query/')
          throw new Error('Only query reads are permitted');
        return client.post(path, {
          ...body,
          query: excludeSynthetic(body.query),
        });
      },
    },
  });
  return {
    ...result,
    exclusion: nonSynthetic,
    logs: 'unchanged: event synthetic flags do not apply to logs',
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      environment: { type: 'string' },
      days: { type: 'string', default: '7' },
      only: { type: 'string' },
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
  const result = await verifyNonsynthetic({
    client: createClient(loadSecrets()),
    environment: values.environment,
    days,
    only: values.only,
    onlyStore: values['only-store'],
    excludeStore: values['exclude-store'],
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
