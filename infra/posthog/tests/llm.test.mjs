import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { llmDashboards } from '../llm/index.mjs';
import { traceFilters } from '../llm/trace-filters.mjs';
import { apply } from '../apply.mjs';
import { verify, scopeQuery } from '../verify.mjs';

const definitions = [
  ...llmDashboards.flatMap((d) => d.insights),
  ...traceFilters,
];

test('LLM scope covers every requested chart and three shared trace filters', () => {
  assert.deepEqual(
    Object.fromEntries(llmDashboards.map((d) => [d.name, d.insights.length])),
    {
      'Assistant health': 6,
      'Cost and tokens': 4,
      'Tools and actions': 7,
      Quality: 4,
    },
  );
  assert.equal(new Set(definitions.map((i) => i.name)).size, 24);
  assert.deepEqual(
    traceFilters.map((i) => i.name),
    [
      'Assistant traces · Errors',
      'Assistant traces · Quota hits',
      'Assistant traces · Rejected actions',
    ],
  );
  const queries = definitions.map((i) => JSON.stringify(i.query)).join('\n');
  assert.match(queries, /assistant_feedback_submitted/);
  assert.doesNotMatch(queries, /assistant_feedback_given|\$ai_feedback/);
  assert.match(queries, /fallback_index/);
  assert.match(queries, /arrayJoin/);
  assert.match(queries, /tool:%/);
  assert.match(queries, /decision = 'rejected'/);
  assert.match(queries, /countIf\(event = '\$ai_trace'\) > 0/);
  assert.match(queries, /permission_leak/);
  const quota = definitions.find((i) => i.scope === 'all');
  assert.equal(quota.query.chartSettings.goalLines[0].value, 1000);
  assert.equal(
    quota.name,
    'Cost and tokens · Requests vs. 1,000/day free quota',
  );
  const funnel = definitions.find((i) => i.query.source.kind === 'FunnelsQuery')
    .query.source;
  assert.equal(funnel.funnelsFilter.funnelWindowInterval, 30);
  assert.equal(funnel.funnelsFilter.funnelWindowIntervalUnit, 'minute');
  assert.equal(funnel.funnelsFilter.breakdownAttributionValue, 0);
});

test('LLM apply is isolated, renders all templates, preserves objects and re-applies without writes', async () => {
  const objects = new Map();
  let writes = 0;
  const client = {
    listAll: async (path) =>
      [...objects.values()].filter((o) => o.endpoint === path.split('?')[0]),
    post: async (endpoint, body) => {
      writes++;
      assert.ok(!JSON.stringify(body).includes('{{'));
      assert.ok(!('scope' in body));
      const object = { ...body, endpoint, id: objects.size + 1 };
      objects.set(object.id, object);
      return object;
    },
    patch: async () => assert.fail('An unchanged re-apply must not PATCH'),
  };
  const first = await apply({ client, only: 'llm', print: () => {} });
  assert.equal(first.length, 28);
  assert.ok(first.every((op) => op.action === 'create'));
  assert.equal(objects.size, 28);
  assert.equal([...objects.values()].filter((o) => o.favorited).length, 3);
  const ids = [...objects.keys()];
  const second = await apply({ client, only: 'llm', print: () => {} });
  assert.equal(writes, 28);
  assert.deepEqual([...objects.keys()], ids);
  assert.ok(second.every((op) => op.status === 'unchanged'));
});

test('LLM offline dry-run is in the default CI plan and can run alone without credentials', () => {
  for (const args of [[], ['--only', 'llm']]) {
    const result = spawnSync(
      process.execPath,
      ['infra/posthog/apply.mjs', '--dry-run', '--offline', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: '/nonexistent',
          POSTHOG_PERSONAL_API_KEY: '',
          POSTHOG_PROJECT_ID: '',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /create dashboard "Assistant health"/);
    assert.match(
      result.stdout,
      /create trace filter "Assistant traces · Rejected actions"/,
    );
    if (args.length)
      assert.doesNotMatch(result.stdout, /Product overview|create flag/);
  }
});

test('LLM verification keeps empty distinct from data, scopes every query except global quota and never hides errors', async () => {
  const original = JSON.stringify(definitions);
  const calls = [];
  const client = {
    post: async (_path, body) => {
      calls.push(body);
      return { results: [] };
    },
  };
  const result = await verify({
    client,
    only: 'llm',
    environment: 'test',
    days: 30,
  });
  assert.equal(result.ok, true);
  assert.equal(result.insights.length, 24);
  assert.ok(
    result.insights.every(
      (i) => i.ok && !i.data && i.note === 'empty (allowed)',
    ),
  );
  for (const { query, name } of calls) {
    assert.ok(!JSON.stringify(query).includes('{{'));
    if (name.includes('free quota')) {
      assert.match(query.query, /AND 1 = 1/);
      assert.doesNotMatch(query.query, /properties.environment/);
    } else if (name.includes('Online judge')) {
      // $ai_evaluation events carry no environment; the judge's sampling filter scopes them.
      assert.doesNotMatch(query.query, /properties.environment/);
      assert.match(query.query, /INTERVAL 30 DAY/);
    } else if (query.kind === 'HogQLQuery') {
      assert.match(query.query, /properties.environment = 'test'/);
      assert.match(query.query, /INTERVAL 30 DAY/);
    } else {
      for (const series of query.series)
        assert.ok(
          series.properties.some(
            (p) => p.key === 'environment' && p.value === 'test',
          ),
        );
    }
  }
  assert.equal(JSON.stringify(definitions), original);
  const failed = await verify({
    client: {
      post: async () => {
        throw new Error('Query failed (400)');
      },
    },
    only: 'llm',
    environment: 'test',
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.insights.every((i) => i.error && !i.ok && !i.data));
  const zero = await verify({
    client: {
      post: async () => ({ results: [['2026-10-28', 'free-model', 0]] }),
    },
    only: 'llm',
    environment: 'test',
  });
  assert.ok(zero.insights.every((i) => i.data));
  await assert.rejects(verify({ client, only: 'typo' }), /--only/);
  assert.throws(
    () => scopeQuery(definitions[0].query, { environment: "test' OR true" }),
    /environment/,
  );
});

test('AI metrics use ai_events columns, retain scoped scans, and avoid trace self-joins', () => {
  const sql = definitions.filter((i) => i.query.source?.kind === 'HogQLQuery');
  for (const insight of sql) {
    const query = scopeQuery(insight.query, {
      environment: 'test',
      days: 7,
    }).query;
    assert.doesNotMatch(
      query,
      /properties\.\$ai_(?:trace_id|model|latency|input_tokens|output_tokens|total_cost_usd|span_name|is_error)/,
      insight.name,
    );
    assert.doesNotMatch(query, /\bJOIN\b/i, insight.name);
    if (query.includes('posthog.ai_events')) {
      const scans = query.match(/FROM (?:posthog\.ai_events|events) WHERE/g);
      const scoped = query.match(
        /INTERVAL 7 DAY AND properties.environment = 'test'/g,
      );
      if (!insight.scope)
        assert.equal(scoped.length, scans.length, insight.name);
    }
  }
  for (const title of ['Model calls per turn', 'Tokens per turn p50 / p95']) {
    const query = definitions.find((i) => i.name.endsWith(`· ${title}`)).query
      .source.query;
    assert.match(query, /FROM posthog\.ai_events/);
    assert.match(
      query,
      /GROUP BY trace_id HAVING countIf\(event = '\$ai_trace'\) > 0/,
    );
  }
  const rate = definitions.find((i) =>
    i.name.endsWith('· Error and quota rate'),
  ).query.source.query;
  assert.match(rate, /UNION ALL SELECT/);
  assert.match(rate, /uniqExactIf\(trace_id, event = 'assistant_quota_hit'\)/);
  const errors = traceFilters[0].query.source.query;
  assert.match(errors, /FROM posthog\.ai_events/);
  assert.match(errors, /is_error = true/);
  for (const filter of traceFilters.slice(1)) {
    assert.match(filter.query.source.query, /FROM events/);
    assert.match(
      filter.query.source.query,
      /nullIf\(JSONExtractString\(toString\(properties\), '\$ai_trace_id'\), ''\)/,
    );
  }
});
