import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboards } from '../definitions/index.mjs';
import { scopeQuery } from '../verify.mjs';

test('verification injects environment into every event/entity without changing definitions', async () => {
  const { scopeQuery } = await import('../verify.mjs');
  const original = JSON.stringify(dashboards);
  for (const dashboard of dashboards)
    for (const insight of dashboard.insights) {
      const query = scopeQuery(insight.query, { environment: 'test', days: 7 });
      assert.notEqual(query.kind, 'InsightVizNode');
      if (query.kind === 'HogQLQuery') {
        assert.ok(!query.query.includes('{{'));
        assert.ok(query.query.includes("= 'test'"));
        assert.ok(query.query.includes('INTERVAL 7 DAY'));
      } else {
        const entities = query.series || [
          query.retentionFilter.targetEntity,
          query.retentionFilter.returningEntity,
        ];
        for (const entity of entities)
          assert.ok(
            entity.properties.some(
              (p) =>
                p.key === 'environment' &&
                p.value === 'test' &&
                p.type === 'event',
            ),
          );
        assert.equal(query.dateRange.date_from, '-7d');
      }
    }
  assert.equal(JSON.stringify(dashboards), original);
});

test('unscoped rendering preserves both environments and substitutes only safe days', async () => {
  const { scopeQuery } = await import('../verify.mjs');
  const template = dashboards.find((d) => d.name === 'Reliability').insights[2]
    .query;
  assert.ok(scopeQuery(template, { days: 30 }).query.includes('AND 1 = 1'));
  assert.match(
    scopeQuery(template, { environment: 'test', days: 7 }).query,
    /resource_attributes\['deployment.environment.name'\] = 'test'/,
  );
  assert.throws(
    () => scopeQuery(template, { environment: "test' OR 1=1", days: 7 }),
    /environment/,
  );
  assert.throws(
    () => scopeQuery(template, { environment: 'test', days: -1 }),
    /days/,
  );
});

test('verifier fails on one empty insight, reports rows, and continues on API errors', async () => {
  const { verify } = await import('../verify.mjs');
  let index = 0;
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push({ path, body });
      index++;
      if (index === 1) return { results: [] };
      if (index === 2) throw new Error('Query failed (400)');
      return { results: [{ count: 3 }] };
    },
  };
  const result = await verify({
    only: 'dashboards',
    client,
    environment: 'test',
    days: 7,
  });
  assert.equal(calls.length, 35);
  assert.equal(result.ok, false);
  assert.equal(result.insights[0].rows, 0);
  assert.equal(result.insights[0].ok, false);
  assert.equal(result.insights[1].ok, false);
  assert.equal(result.insights[2].ok, true);
  assert.ok(
    calls.every(
      (c) => c.path === 'query/' && c.body.refresh === 'force_blocking',
    ),
  );
});

test('zero-filled trend results are not evidence of data; nonzero results are', async () => {
  const { hasData } = await import('../verify.mjs');
  assert.equal(
    hasData([{ data: [0, 0], count: 0, label: 'sale_completed' }]),
    false,
  );
  assert.equal(hasData([{ data: [0, 2], count: 2 }]), true);
  assert.equal(hasData([]), false);
  assert.equal(hasData([['test', '/v1/sales', 0, 3]]), true);
});

test('a zero-percent formula still verifies when its denominator has input events', async () => {
  const { verify } = await import('../verify.mjs');
  let queryCount = 0;
  const client = {
    post: async (_path, { query }) => {
      queryCount++;
      if (query.kind === 'TrendsQuery' && query.trendsFilter?.formula)
        return { results: [{ data: [0], count: 0 }] };
      return { results: [{ data: [2], count: 2 }] };
    },
  };
  const result = await verify({
    only: 'dashboards',
    client,
    environment: 'test',
  });
  assert.equal(result.ok, true);
  assert.ok(queryCount > 35);
});

test('a bold number with an aggregated value counts as data', async () => {
  const { hasData } = await import('../verify.mjs');
  assert.equal(hasData([{ data: [], aggregated_value: 13 }]), true);
  assert.equal(hasData([{ data: [], aggregated_value: 0 }]), false);
});

test('allow-empty marks matching empty insights as ok without hiding errors', async () => {
  const { verify } = await import('../verify.mjs');
  let index = 0;
  const client = {
    post: async () => {
      index++;
      if (index === 1) return { results: [] };
      if (index === 2) throw new Error('Query failed (400)');
      return { results: [{ count: 3 }] };
    },
  };
  const result = await verify({
    only: 'dashboards',
    client,
    environment: 'test',
    days: 7,
    allowEmpty: /DAU|Active stores/,
  });
  assert.equal(result.insights[0].ok, true);
  assert.equal(result.insights[0].note, 'empty (allowed)');
  assert.equal(result.insights[1].ok, false);
  assert.equal(result.ok, false);
});

test('store filtering covers every managed event scan, entity and log without mutating definitions', async () => {
  const { scopeQuery, verify } = await import('../verify.mjs');
  const { llmDashboards } = await import('../llm/index.mjs');
  const { traceFilters } = await import('../llm/trace-filters.mjs');
  const store = '11111111-2222-4333-8444-555555555555';
  for (const dashboard of [
    ...dashboards,
    ...llmDashboards,
    { insights: traceFilters },
  ]) {
    for (const insight of dashboard.insights) {
      const original = JSON.stringify(insight.query);
      for (const options of [{ onlyStore: store }, { excludeStore: store }]) {
        const query = scopeQuery(insight.query, {
          environment: 'production',
          days: 1,
          ...options,
        });
        if (query.kind === 'HogQLQuery') {
          const scans = query.query.match(
            /FROM (events|posthog\.ai_events|logs) WHERE/gi,
          );
          assert.equal(query.query.split(store).length - 1, scans.length);
          if (options.excludeStore) assert.match(query.query, /coalesce\(/);
        } else {
          const entities = query.series ?? [
            query.retentionFilter.targetEntity,
            query.retentionFilter.returningEntity,
          ];
          assert.ok(
            entities.every((e) =>
              e.properties.some(
                (p) => p.type === 'hogql' && p.key.includes(store),
              ),
            ),
          );
        }
      }
      assert.equal(JSON.stringify(insight.query), original);
    }
  }
  for (const options of [
    { onlyStore: "x' OR 1=1" },
    { onlyStore: store, excludeStore: store },
  ])
    assert.throws(() => scopeQuery({ kind: 'TrendsQuery' }, options), /store/i);
  const calls = [];
  await verify({
    environment: 'production',
    days: 1,
    onlyStore: store,
    client: {
      post: async (_, body) => {
        calls.push(body);
        return { results: [] };
      },
    },
  });
  const quota = calls.find((c) => c.name?.includes('1,000/day'));
  assert.ok(
    !JSON.stringify(quota.query).includes(store),
    'shared quota remains global',
  );
  assert.ok(
    calls
      .filter((c) => c !== quota && !c.name?.includes('Online judge'))
      .every((c) => JSON.stringify(c.query).includes(store)),
  );
});

for (const [shape, sql, aiScans, eventScans] of [
  [
    'direct AI scan',
    'SELECT count() FROM posthog.ai_events WHERE {{environment}}',
    1,
    0,
  ],
  [
    'nested AI aggregation',
    'SELECT calls FROM (SELECT trace_id, count() AS calls FROM posthog.ai_events WHERE {{environment}} GROUP BY trace_id)',
    1,
    0,
  ],
  [
    'AI and product union',
    'SELECT event FROM posthog.ai_events WHERE {{environment}} UNION ALL SELECT event FROM events WHERE {{environment}}',
    1,
    1,
  ],
  [
    'repeated AI scans',
    'SELECT trace_id FROM posthog.ai_events WHERE trace_id IN (SELECT trace_id FROM posthog.ai_events WHERE {{environment}})',
    2,
    0,
  ],
]) {
  test(`store filter scopes each scan in ${shape}`, () => {
    const store = '11111111-2222-4333-8444-555555555555';
    const original = { kind: 'HogQLQuery', query: sql };
    const aiField =
      "JSONExtractString(toString(properties), '$groups', 'store')";
    for (const options of [{ onlyStore: store }, { excludeStore: store }]) {
      const query = scopeQuery(original, {
        environment: 'production',
        ...options,
      });
      const condition = (field) =>
        options.onlyStore
          ? `${field} = '${store}'`
          : `coalesce(${field}, '') != '${store}'`;
      assert.equal(
        query.query.split(
          `FROM posthog.ai_events WHERE (${condition(aiField)}) AND`,
        ).length - 1,
        aiScans,
      );
      assert.equal(
        query.query.split(
          `FROM events WHERE (${condition('properties.$groups.store')}) AND`,
        ).length - 1,
        eventScans,
      );
      assert.equal(query.query.split(store).length - 1, aiScans + eventScans);
    }
    assert.equal(original.query, sql);
  });
}

test('store filter rejects unsupported SQL and query shapes before they can run unfiltered', async () => {
  const { scopeQuery } = await import('../verify.mjs');
  const options = { onlyStore: '11111111-2222-4333-8444-555555555555' };
  for (const query of [
    { kind: 'HogQLQuery', query: 'SELECT * FROM events e WHERE true' },
    { kind: 'HogQLQuery', query: 'SELECT * FROM events' },
    {
      kind: 'HogQLQuery',
      query: 'SELECT * FROM posthog.ai_events a WHERE true',
    },
    { kind: 'HogQLQuery', query: 'SELECT * FROM posthog.ai_events' },
    { kind: 'HogQLQuery', query: 'SELECT * FROM ai_events WHERE true' },
    {
      kind: 'HogQLQuery',
      query: 'SELECT * FROM posthog.ai_events WHERE true JOIN events ON true',
    },
    {
      kind: 'HogQLQuery',
      query:
        'SELECT * FROM events WHERE true UNION ALL SELECT * FROM posthog.ai_events a WHERE true',
    },
    { kind: 'TrendsQuery' },
  ])
    assert.throws(() => scopeQuery(query, options), /Unsupported store filter/);
});
