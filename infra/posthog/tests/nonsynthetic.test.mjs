import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboards } from '../definitions/index.mjs';
import { llmDashboards } from '../llm/index.mjs';
import { traceFilters } from '../llm/trace-filters.mjs';
import { scopeQuery } from '../verify.mjs';
import {
  excludeSynthetic,
  verifyNonsynthetic,
  nonSynthetic,
} from '../verify-nonsynthetic.mjs';

test('excludes flagged and known synthetic events at every SQL scan without mutation', () => {
  const original = {
    kind: 'HogQLQuery',
    query:
      'SELECT * FROM events WHERE event IN (SELECT event FROM events WHERE timestamp > now())',
  };
  const query = excludeSynthetic(original);
  assert.equal(query.query.split(nonSynthetic).length - 1, 2);
  assert.ok(!original.query.includes('synthetic'));
  assert.match(nonSynthetic, /NOT coalesce\(properties.synthetic, false\)/);
  assert.match(nonSynthetic, /distinct_id != 'synthetic-x6-validation'/);
});

test('covers all managed query shapes, including retention entities; leaves logs intact', () => {
  for (const dashboard of [
    ...dashboards,
    ...llmDashboards,
    { insights: traceFilters },
  ]) {
    for (const insight of dashboard.insights) {
      const original = scopeQuery(insight.query, {
        environment: 'test',
        days: 7,
      });
      const query = excludeSynthetic(original);
      if (query.kind === 'HogQLQuery') {
        if (/FROM logs\b/.test(query.query)) assert.deepEqual(query, original);
        else assert.ok(query.query.includes(nonSynthetic), insight.name);
      } else {
        const entities = query.series ?? [
          query.retentionFilter.targetEntity,
          query.retentionFilter.returningEntity,
        ];
        for (const entity of entities) {
          assert.ok(
            entity.properties.some(
              (p) => p.type === 'hogql' && p.key === nonSynthetic,
            ),
          );
          assert.ok(
            entity.properties.some(
              (p) => p.key === 'environment' && p.value === 'test',
            ),
          );
        }
      }
    }
  }
});

test('fails closed on unsupported SQL and native shapes', () => {
  assert.throws(
    () =>
      excludeSynthetic({
        kind: 'HogQLQuery',
        query: 'SELECT count() FROM events',
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      excludeSynthetic({
        kind: 'HogQLQuery',
        query: 'SELECT * FROM events e WHERE true',
      }),
    /Unsupported/,
  );
  assert.throws(
    () => excludeSynthetic({ kind: 'UnknownQuery' }),
    /Unsupported/,
  );
});

test('read-only verifier filters denominator probes, keeps quota global, and reports empties', async () => {
  const calls = [];
  const result = await verifyNonsynthetic({
    environment: 'test',
    days: 7,
    client: {
      post: async (path, body) => {
        assert.equal(path, 'query/');
        calls.push(body);
        return { results: [] };
      },
    },
  });
  assert.equal(result.insights.length, 59);
  assert.equal(result.ok, false);
  assert.ok(result.insights.every((row) => row.data === false));
  assert.ok(calls.length > 59); // formula denominator evidence is filtered too
  const quota = calls.find((c) => c.name?.includes('Requests vs.'));
  assert.ok(quota.query.query.includes(nonSynthetic));
  assert.ok(!quota.query.query.includes("properties.environment = 'test'"));
  assert.ok(calls.every((c) => c.refresh === 'force_blocking'));
});
