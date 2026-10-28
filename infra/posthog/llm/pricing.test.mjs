import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantModels,
  configuredModels,
  fetchPrices,
  hogql,
  modelPrices,
  parseMode,
} from './pricing.mjs';
import { applyPricing } from './pricing-apply.mjs';
import { costEvidence, costQuery, verifyPricing } from './pricing-verify.mjs';

const catalog = (id, prompt = '0', completion = '0', extra = {}) => ({
  data: [{ id, pricing: { prompt, completion, ...extra } }],
});

test('covers all deployed models plus legacy backend fallback, with deduped overrides', () => {
  assert.equal(configuredModels({}).length, 5);
  for (const model of assistantModels)
    assert.ok(configuredModels({}).includes(model));
  assert.deepEqual(
    configuredModels({ ASSISTANT_MODELS: ' openai/test,openai/test ' }),
    ['openai/test'],
  );
  for (const value of ['', ' , ', "x/y'; DROP TABLE events"])
    assert.throws(() => configuredModels({ ASSISTANT_MODELS: value }));
});
test('free models are zero, including retired free model absent from catalog', () => {
  const [price] = modelPrices(['x/y:free'], { data: [] });
  assert.deepEqual(price.event_properties, {
    $ai_input_token_price: 0,
    $ai_output_token_price: 0,
  });
  assert.match(price.source, /absent/);
  assert.throws(() => modelPrices(['x/y:free'], catalog('x/y:free', '0.1')));
});
test('paid rates come from OpenRouter USD per individual token, never per million', () => {
  const [price] = modelPrices(
    ['x/paid'],
    catalog('x/paid', '0.00000015', '0.0000006'),
  );
  assert.equal(price.input, 0.00000015);
  assert.equal(price.output, 0.0000006);
  assert.throws(() => modelPrices(['x/paid'], { data: [] }), /missing/);
});
test('fails closed on malformed, duplicate or unsupported pricing components', () => {
  for (const value of ['-1', 'NaN', 'Infinity', '', null, 0])
    assert.throws(() => modelPrices(['x/paid'], catalog('x/paid', value)));
  assert.throws(
    () =>
      modelPrices(
        ['x/paid'],
        catalog('x/paid', '0.1', '0.1', { request: '0.1' }),
      ),
    /Additional/,
  );
  assert.throws(
    () =>
      modelPrices(['x/paid'], {
        data: [...catalog('x/paid').data, ...catalog('x/paid').data],
      }),
    /Ambiguous/,
  );
  assert.throws(() => modelPrices([], {}), /Invalid/);
});
test('catalog fetch is public, bounded and rejects upstream errors', async () => {
  await fetchPrices(['x/y:free'], async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.equal(options.headers, undefined);
    assert.ok(options.signal);
    return { ok: true, json: async () => catalog('x/y:free') };
  });
  await assert.rejects(
    fetchPrices([], async () => ({ ok: false, status: 503 })),
    /503/,
  );
});
test('pricing apply is explicit about unsupported project CRUD and has zero writes', async () => {
  const result = await applyPricing({ prices: async () => [] });
  assert.equal(result.dryRun, true);
  assert.equal(result.changes, 0);
  assert.equal(result.status, 'event_properties_required');
});
test('dry-run is default and invalid flags cannot trigger writes', () => {
  assert.deepEqual(parseMode([]), { dryRun: true });
  assert.deepEqual(parseMode(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseMode(['--apply']), { dryRun: false });
  assert.throws(() => parseMode(['--apply', '--dry-run']));
  assert.throws(() => parseMode(['--unknown']));
});
test('zero/missing data is never a passing cost check', async () => {
  const price = { model: assistantModels[0], input: 0, output: 0 };
  assert.equal(
    costEvidence(price, [[0, 0, 0, 0, [], null]]).status,
    'no_test_generations',
  );
  for (const counts of [
    [2, 1, 0, 0],
    [2, 0, 1, 0],
    [2, 0, 0, 1],
  ])
    assert.equal(costEvidence(price, [[...counts, [], 0]]).status, 'failed');
  assert.equal(
    costEvidence(price, [[2, 0, 0, 0, ['passthrough'], 0]]).status,
    'passed',
  );
  const result = await verifyPricing(
    { post: async () => ({ results: [[0, 0, 0, 0, [], 0]] }) },
    [price],
  );
  assert.equal(result.passed, false);
  assert.throws(() => costEvidence(price, []));
});
test('cost query checks both token components and total, exact test/provider/model and 30 days', () => {
  const sql = costQuery({ model: 'x/paid', input: 0.1, output: 0.2 });
  for (const part of [
    "environment = 'test'",
    "provider = 'openrouter'",
    "model = 'x/paid'",
    'INTERVAL 30 DAY',
    'missing_tokens',
    'missing_costs',
    '* 0.1',
    '* 0.2',
    '$ai_total_cost_usd',
  ])
    assert.ok(sql.includes(part), part);
});
test('query helper requires synchronous complete evidence and forces refresh', async () => {
  const client = {
    post: async (path, body) => {
      assert.equal(path, 'query/');
      assert.equal(body.query.kind, 'HogQLQuery');
      assert.equal(body.refresh, 'force_blocking');
      return { results: [[1]] };
    },
  };
  assert.deepEqual(await hogql(client, 'SELECT 1'), [[1]]);
  for (const response of [
    {},
    { results: [], error: 'failed' },
    { results: [], hasMore: true },
  ])
    await assert.rejects(hogql({ post: async () => response }, 'SELECT 1'));
});
