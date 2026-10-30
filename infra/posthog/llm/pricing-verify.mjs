import { fetchPrices, hogql, liveClient, main, sqlString } from './pricing.mjs';

// Allow 10% provider price variation and 1e-8 USD absolute rounding. Cached input
// and catalog context tiers define a bounded price interval, rather than assuming list price.
export const COST_RELATIVE_TOLERANCE = 0.1;
export const COST_ABSOLUTE_TOLERANCE = 1e-8;
export function costQuery({
  model,
  input,
  output,
  inputMin = input,
  inputMax = input,
  outputMin = output,
  outputMax = output,
}) {
  const free = model.endsWith(':free');
  const bounds = (component, tokens, min, max) =>
    free
      ? `toFloat(${component}) != 0`
      : `(toFloat(${component}) < toFloat(${tokens}) * ${min} * 0.9 - 1e-8 OR toFloat(${component}) > toFloat(${tokens}) * ${max} * 1.1 + 1e-8)`;
  return `SELECT count() AS generations,
    countIf(isNull(input_tokens) OR isNull(output_tokens)) AS missing_tokens,
    countIf(isNull(input_cost_usd) OR isNull(output_cost_usd) OR isNull(total_cost_usd)) AS missing_costs,
    countIf(${bounds('input_cost_usd', 'input_tokens', inputMin, inputMax)}
      OR ${bounds('output_cost_usd', 'output_tokens', outputMin, outputMax)}
      OR abs(toFloat(total_cost_usd) - (toFloat(input_cost_usd) + toFloat(output_cost_usd))) > ${free ? 0 : 1e-8}) AS mismatches,
    groupUniqArray(toString(properties.$ai_cost_model_source)) AS cost_sources,
    sum(toFloat(total_cost_usd)) AS total_cost_usd
    FROM posthog.ai_events WHERE event = '$ai_generation' AND properties.environment = 'test'
      AND provider = 'openrouter' AND model = ${sqlString(model)}
      AND timestamp >= now() - INTERVAL 30 DAY`;
}

export function costEvidence(price, rows) {
  if (rows.length !== 1 || rows[0].length !== 6)
    throw new Error('Invalid cost query result');
  const [
    generations,
    missing_tokens,
    missing_costs,
    mismatches,
    cost_sources,
    total_cost_usd,
  ] = rows[0];
  if (
    ![generations, missing_tokens, missing_costs, mismatches].every(
      (n) => Number.isInteger(n) && n >= 0,
    )
  )
    throw new Error('Invalid cost query counts');
  return {
    model: price.model,
    input_price: price.input,
    output_price: price.output,
    generations,
    missing_tokens,
    missing_costs,
    mismatches,
    cost_sources,
    total_cost_usd,
    status:
      generations === 0
        ? 'no_test_generations'
        : missing_tokens || missing_costs || mismatches
          ? 'failed'
          : 'passed',
    proof:
      'Stored PostHog costs vs catalog text/cache price bounds (10% + 1e-8 USD tolerance); passthrough values do not prove ingestion calculation.',
  };
}

export async function verifyPricing(client, prices) {
  const models = [];
  for (const price of prices)
    models.push(costEvidence(price, await hogql(client, costQuery(price))));
  return { passed: models.every((m) => m.status === 'passed'), models };
}

main(import.meta, async () => {
  if (process.argv.length > 2)
    throw new Error('pricing-verify takes no arguments');
  const result = await verifyPricing(liveClient(), await fetchPrices());
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
});
