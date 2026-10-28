import { chart, dashboard, number, tokens, where } from './helpers.mjs';
export default dashboard('Cost and tokens', [
  [
    'Input / output tokens per day by model',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.$ai_model AS model, sum(${number('$ai_input_tokens')}) AS input_tokens, sum(${number('$ai_output_tokens')}) AS output_tokens FROM events WHERE ${where} AND event = '$ai_generation' GROUP BY day, model ORDER BY day`,
      'ActionsStackedBar',
      'day',
      ['input_tokens', 'output_tokens'],
      'model',
    ),
    'Token totals include all generation attempts, including retries and fallbacks.',
  ],
  [
    'Tokens per turn p50 / p95',
    chart(
      `SELECT day, quantile(0.5)(turn_tokens) AS p50_tokens, quantile(0.95)(turn_tokens) AS p95_tokens FROM (SELECT toStartOfDay(minIf(timestamp, event = '$ai_trace')) AS day, properties.$ai_trace_id AS trace_id, sumIf(${tokens}, event = '$ai_generation') AS turn_tokens FROM events WHERE ${where} AND event IN ('$ai_trace', '$ai_generation') AND properties.$ai_trace_id IS NOT NULL GROUP BY trace_id HAVING countIf(event = '$ai_trace') > 0) GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['p50_tokens', 'p95_tokens'],
    ),
    'Input + output tokens summed across attempts per trace before calculating daily turn percentiles; zero-call turns included.',
  ],
  [
    'Cost per day by model',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.$ai_model AS model, sum(coalesce(${number('$ai_total_cost_usd')}, ${number('$ai_input_cost_usd')} + ${number('$ai_output_cost_usd')})) AS cost_usd FROM events WHERE ${where} AND event = '$ai_generation' AND (properties.$ai_total_cost_usd IS NOT NULL OR (properties.$ai_input_cost_usd IS NOT NULL AND properties.$ai_output_cost_usd IS NOT NULL)) GROUP BY day, model ORDER BY day`,
      'ActionsStackedBar',
      'day',
      ['cost_usd'],
      'model',
    ),
    'USD from PostHog cost properties; free models emit explicit zero. Missing paid-model costs are excluded, never assumed zero. Pricing is owned by #63.',
  ],
  [
    'Requests vs. 1,000/day free quota',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, count() AS requests FROM events WHERE ${where} AND event = '$ai_generation' GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['requests'],
      undefined,
      { goalLines: [{ label: 'Free quota: 1,000 requests/day', value: 1000 }] },
    ),
    'All generation attempts across every environment. Verification deliberately keeps this global provider-budget view unscoped. Target is the specified 1,000/day budget, not live provider quota discovery.',
    'all',
  ],
]);
