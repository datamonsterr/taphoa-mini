import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvaluation } from './evaluations-apply.mjs';
import {
  evaluationName,
  judgeDefinition,
  judgeModel,
  rubric,
} from './evaluations.mjs';
import { resultsQuery, verifyEvaluation } from './evaluations-verify.mjs';
import { runOne } from './evaluations-run.mjs';

function fixture({
  requiresKey = false,
  models = true,
  existing = [],
  keys = [{ id: 'key-id', provider: 'openai', state: 'ok' }],
  active = 'key-id',
  rows = [[0, null, null, []]],
} = {}) {
  const writes = [];
  const client = {
    get: async (path) =>
      path.includes('models/')
        ? {
            models: models ? [{ provider: 'openai', id: 'gpt-4.1-mini' }] : [],
            providers: [
              { provider: 'openai', requires_provider_key: requiresKey },
            ],
          }
        : { active_provider_key: active },
    listAll: async (path) => (path === 'evaluations/' ? existing : keys),
    post: async (path, body) => {
      if (path === 'query/') return { results: rows };
      writes.push({ method: 'POST', path, body });
      if (path === 'evaluations/') {
        const e = {
          ...body,
          id: 'managed-id',
          status: 'active',
          created_at: 'ignored',
        };
        existing.push(e);
        return e;
      }
      return { status: 'queued' };
    },
    patch: async (path, body) => {
      writes.push({ method: 'PATCH', path, body });
      Object.assign(existing[0], body);
      return existing[0];
    },
  };
  return { client, writes, existing };
}
test('Vietnamese numeric rubric and environment sampling are explicit', () => {
  const d = judgeDefinition({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    provider_key_id: null,
  });
  assert.equal(d.target, 'generation');
  assert.equal(d.output_type, 'numeric');
  assert.deepEqual(
    d.conditions.map((c) => c.rollout_percentage),
    [100, 10],
  );
  assert.deepEqual(
    d.conditions.map((c) => c.properties[0].value),
    [['test'], ['production']],
  );
  assert.ok(
    d.conditions.every(
      (c) =>
        c.properties[1].value[0] === 'openrouter' &&
        c.properties[2].value.length === 5,
    ),
  );
  for (const fragment of [
    'Số liệu có căn cứ',
    'tiếng Việt',
    'Hữu ích',
    'Quyền hạn',
    'điểm tổng bằng 0',
  ])
    assert.ok(rubric.includes(fragment));
  assert.deepEqual(d.output_config.passing_rule, {
    operator: 'gte',
    threshold: 4,
  });
});
test('live model catalog must support judge; healthy active connection is pinned', async () => {
  await assert.rejects(
    judgeModel(fixture({ models: false }).client),
    /does not advertise/,
  );
  const missing = await judgeModel(
    fixture({ requiresKey: true, keys: [], active: null }).client,
  );
  assert.equal(judgeDefinition(missing).enabled, false);
  const result = await judgeModel(
    fixture({
      requiresKey: true,
      active: 'key-id',
      keys: [{ id: 'key-id', provider: 'openai', state: 'ok' }],
    }).client,
  );
  assert.equal(result.provider_key_id, 'key-id');
});
test('missing or unhealthy connections save paused even if catalog advertises keyless access', async () => {
  for (const keys of [
    [],
    [{ id: 'key-id', provider: 'openai', state: 'error' }],
    [{ id: 'key-id', provider: 'anthropic', state: 'ok' }],
  ]) {
    const f = fixture({ keys });
    const result = await applyEvaluation(f.client, { dryRun: false });
    assert.equal(result.enabled, false);
    assert.match(result.blocker, /connection/);
    assert.equal(result.definition.model_configuration.provider_key_id, null);
  }
});
test('default dry-run creates no object', async () => {
  const f = fixture();
  const r = await applyEvaluation(f.client);
  assert.equal(r.action, 'create');
  assert.equal(r.dryRun, true);
  assert.equal(f.writes.length, 0);
});
test('adding a healthy connection enables the same paused judge on the next apply', async () => {
  const keys = [];
  const f = fixture({ keys });
  const paused = await applyEvaluation(f.client, { dryRun: false });
  assert.equal(paused.enabled, false);
  keys.push({ id: 'key-id', provider: 'openai', state: 'ok' });
  const enabled = await applyEvaluation(f.client, { dryRun: false });
  assert.equal(enabled.action, 'update');
  assert.equal(enabled.id, paused.id);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.blocker, null);
  assert.equal((await applyEvaluation(f.client, { dryRun: false })).changes, 0);
});
test('apply twice creates once then reports zero changes despite server defaults', async () => {
  const f = fixture();
  const first = await applyEvaluation(f.client, { dryRun: false });
  f.existing[0].model_configuration.provider_key_name = 'server default';
  const second = await applyEvaluation(f.client, { dryRun: false });
  assert.equal(first.action, 'create');
  assert.equal(second.action, 'unchanged');
  assert.equal(second.changes, 0);
  assert.equal(f.writes.length, 1);
});
test('owned drift updates in place and does not touch other evaluations', async () => {
  const f = fixture();
  await applyEvaluation(f.client, { dryRun: false });
  f.existing[0].conditions[1].rollout_percentage = 100;
  f.existing.push({ id: 'someone-elses', name: 'unrelated' });
  const result = await applyEvaluation(f.client, { dryRun: false });
  assert.equal(result.action, 'update');
  assert.equal(f.writes[1].path, 'evaluations/managed-id/');
  assert.deepEqual(f.existing[1], { id: 'someone-elses', name: 'unrelated' });
});
test('ambiguous names and silently altered API responses are rejected', async () => {
  const f = fixture({
    existing: [{ name: evaluationName }, { name: evaluationName }],
  });
  await assert.rejects(
    applyEvaluation(f.client, { dryRun: false }),
    /Ambiguous/,
  );
  assert.equal(f.writes.length, 0);
  const g = fixture();
  g.client.post = async () => ({ enabled: false });
  await assert.rejects(applyEvaluation(g.client, { dryRun: false }), /differs/);
});
test('verification requires a real score linked to test generation; disabled/drift cannot pass', async () => {
  const f = fixture();
  await applyEvaluation(f.client, { dryRun: false });
  assert.equal((await verifyEvaluation(f.client)).passed, false);
  const g = fixture({ existing: f.existing, rows: [[1, 4, 4, ['x/y:free']]] });
  assert.equal((await verifyEvaluation(g.client)).passed, true);
  g.existing[0].model_configuration.model = 'different-model';
  assert.equal((await verifyEvaluation(g.client)).configurationMatches, false);
  g.existing[0].model_configuration.model = 'gpt-4.1-mini';
  g.existing[0].enabled = false;
  assert.equal((await verifyEvaluation(g.client)).passed, false);
  assert.ok(
    resultsQuery('managed-id').includes('g.generation_id = e.target_id'),
  );
  for (const text of [
    "properties.environment = 'test'",
    '$ai_evaluation_numeric_result',
    '$ai_target_event_id',
    '$ai_evaluation_skipped',
    "provider = 'openrouter'",
  ])
    assert.ok(resultsQuery('managed-id').includes(text));
});
test('one-generation runs reject a paused judge without enqueueing', async () => {
  const f = fixture({ keys: [] });
  await applyEvaluation(f.client, { dryRun: false });
  await assert.rejects(runOne(f.client, { dryRun: false }), /enable/);
  assert.equal(f.writes.length, 1);
});
test('one-generation run skips when score exists and dry-run does not enqueue', async () => {
  const f = fixture();
  await applyEvaluation(f.client, { dryRun: false });
  const scored = fixture({ existing: f.existing, rows: [[1, 4, 4, []]] });
  assert.equal(
    (await runOne(scored.client, { dryRun: false })).action,
    'unchanged',
  );
  assert.equal(scored.writes.length, 0);
  const original = f.client.post;
  f.client.post = async (path, body) =>
    path === 'query/' && body.query.query.includes('ORDER BY timestamp')
      ? {
          results: [
            ['11111111-1111-1111-1111-111111111111', '2026-10-28T10:00:00Z'],
          ],
        }
      : original(path, body);
  const planned = await runOne(f.client);
  assert.equal(planned.payload.timestamp, '2026-10-28T10:00:00.000Z');
  assert.equal(f.writes.length, 1);
  await runOne(f.client, { dryRun: false });
  assert.equal(f.writes[1].path, 'evaluation_runs/');
});
