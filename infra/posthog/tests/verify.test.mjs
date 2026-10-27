import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboards } from '../definitions/index.mjs';

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
  const result = await verify({ client, environment: 'test', days: 7 });
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
  const result = await verify({ client, environment: 'test' });
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
