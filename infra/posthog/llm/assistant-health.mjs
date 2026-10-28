import { chart, dashboard, number, where } from './helpers.mjs';
export default dashboard('Assistant health', [
  [
    'Turns per day by environment',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.environment AS environment, count() AS turns FROM events WHERE ${where} AND event = '$ai_trace' GROUP BY day, environment ORDER BY day`,
      'ActionsStackedBar',
      'day',
      ['turns'],
      'environment',
    ),
    'Explicit backend $ai_trace events; one per completed turn.',
  ],
  [
    'Turn latency p50 / p95',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, quantile(0.5)(${number('$ai_latency')}) AS p50_seconds, quantile(0.95)(${number('$ai_latency')}) AS p95_seconds FROM events WHERE ${where} AND event = '$ai_trace' AND properties.$ai_latency IS NOT NULL GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['p50_seconds', 'p95_seconds'],
    ),
    'Turn latency in seconds, as emitted by the backend.',
  ],
  [
    'Time to first token p50 / p95 by model',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.$ai_model AS model, quantile(0.5)(${number('time_to_first_token_ms')}) AS p50_ms, quantile(0.95)(${number('time_to_first_token_ms')}) AS p95_ms FROM events WHERE ${where} AND event = '$ai_generation' AND properties.time_to_first_token_ms IS NOT NULL GROUP BY day, model ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['p50_ms', 'p95_ms'],
      'model',
    ),
    'Milliseconds; null TTFT on failed/non-streaming attempts is excluded.',
  ],
  [
    'Model calls per turn',
    chart(
      `SELECT model_calls, count() AS turns FROM (SELECT properties.$ai_trace_id AS trace_id, countIf(event = '$ai_generation') AS model_calls FROM events WHERE ${where} AND event IN ('$ai_trace', '$ai_generation') AND properties.$ai_trace_id IS NOT NULL GROUP BY trace_id HAVING countIf(event = '$ai_trace') > 0) GROUP BY model_calls ORDER BY model_calls`,
      'ActionsUnstackedBar',
      'model_calls',
      ['turns'],
    ),
    'Discrete histogram of generation attempts per explicit trace; includes zero-call turns.',
  ],
  [
    'Error and quota rate',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, 100.0 * countIf(event = '$ai_generation' AND properties.$ai_is_error = true) / nullIf(countIf(event = '$ai_generation'), 0) AS generation_error_percent, 100.0 * uniqExactIf(properties.$ai_trace_id, event = 'assistant_quota_hit') / nullIf(uniqExactIf(properties.$ai_trace_id, event = '$ai_trace'), 0) AS quota_turn_percent FROM events WHERE ${where} AND event IN ('$ai_generation', '$ai_trace', 'assistant_quota_hit') GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['generation_error_percent', 'quota_turn_percent'],
    ),
    'Generation error rate uses model calls; quota rate uses unique hit trace ids / unique completed turn trace ids. Multiple quota scopes count once per turn.',
  ],
  [
    'Fallback rate by model',
    chart(
      `SELECT properties.$ai_model AS model, 100.0 * countIf(${number('fallback_index')} > 0) / nullIf(count(), 0) AS fallback_percent FROM events WHERE ${where} AND event = '$ai_generation' GROUP BY model ORDER BY fallback_percent DESC`,
      'ActionsUnstackedBar',
      'model',
      ['fallback_percent'],
    ),
    'Fraction of this model’s generation attempts with fallback_index > 0.',
  ],
]);
