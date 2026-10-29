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
  assert.match(
    nonSynthetic,
    /NOT coalesce\(toBool\(properties.synthetic\), false\)/,
  );
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
  assert.equal(result.insights.length, 67);
  assert.equal(result.ok, false);
  assert.ok(result.insights.every((row) => row.data === false));
  assert.ok(calls.length > 67); // formula denominator evidence is filtered too
  const quota = calls.find((c) => c.name?.includes('Requests vs.'));
  assert.ok(quota.query.query.includes(nonSynthetic));
  assert.ok(!quota.query.query.includes("properties.environment = 'test'"));
  assert.ok(calls.every((c) => c.refresh === 'force_blocking'));
});

test('filters ai_events and events independently in a scoped union and rejects unsupported AI scans', () => {
  const template = {
    kind: 'HogQLQuery',
    query:
      'SELECT event FROM posthog.ai_events WHERE {{environment}} AND timestamp >= now() - INTERVAL {{days}} DAY UNION ALL SELECT event FROM events WHERE {{environment}} AND timestamp >= now() - INTERVAL {{days}} DAY',
  };
  const scoped = scopeQuery(template, { environment: 'test', days: 7 });
  const filtered = excludeSynthetic(scoped);
  assert.equal(filtered.query.split(nonSynthetic).length - 1, 2);
  assert.equal(
    filtered.query.split("properties.environment = 'test'").length - 1,
    2,
  );
  assert.match(filtered.query, /FROM posthog\.ai_events WHERE \(NOT coalesce/);
  assert.match(filtered.query, /FROM events WHERE \(NOT coalesce/);
  assert.equal(scoped.query.includes('synthetic'), false);
  for (const query of [
    'SELECT count() FROM posthog.ai_events',
    'SELECT * FROM posthog.ai_events a WHERE true',
    'SELECT * FROM events WHERE true JOIN posthog.ai_events ON events.uuid = ai_events.uuid',
  ])
    assert.throws(
      () => excludeSynthetic({ kind: 'HogQLQuery', query }),
      /Unsupported/,
    );
});

test('non-synthetic verification composes with both store filters on every managed scan', async () => {
  const store = '11111111-2222-4333-8444-555555555555';
  for (const options of [{ onlyStore: store }, { excludeStore: store }]) {
    const calls = [];
    const result = await verifyNonsynthetic({
      environment: 'production',
      days: 2,
      ...options,
      client: {
        post: async (_path, body) => {
          calls.push(body);
          return { results: [] };
        },
      },
    });
    assert.equal(result.insights.length, 67);
    assert.ok(result.insights.every((row) => !row.error));
    for (const { query, name } of calls) {
      const global = /1,000\/day|Online judge/.test(name ?? '');
      if (query.kind === 'HogQLQuery') {
        const scans = query.query.match(
          /FROM (events|posthog\.ai_events|logs) WHERE/gi,
        );
        assert.equal(
          query.query.split(store).length - 1,
          global ? 0 : scans.length,
        );
        if (!/FROM logs/.test(query.query))
          assert.equal(
            query.query.split(nonSynthetic).length - 1,
            scans.length,
          );
      } else {
        for (const entity of query.series ?? [
          query.retentionFilter.targetEntity,
          query.retentionFilter.returningEntity,
        ]) {
          assert.ok(entity.properties.some((p) => p.key === nonSynthetic));
          assert.ok(
            entity.properties.some(
              (p) => p.type === 'hogql' && p.key.includes(store),
            ),
          );
        }
      }
    }
  }
});
