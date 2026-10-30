import {
  chart,
  dashboard,
  number,
  productTraceId,
  assistantWhere,
} from './helpers.mjs';
export default dashboard('Assistant health', [
  [
    'Turns per day by environment',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.environment AS environment, count() AS turns FROM posthog.ai_events WHERE ${assistantWhere} AND event = '$ai_trace' GROUP BY day, environment ORDER BY day`,
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
      `SELECT toStartOfDay(timestamp) AS day, quantile(0.5)(latency) AS p50_seconds, quantile(0.95)(latency) AS p95_seconds FROM posthog.ai_events WHERE ${assistantWhere} AND event = '$ai_trace' AND latency IS NOT NULL GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['p50_seconds', 'p95_seconds'],
    ),
    'Turn latency in seconds, as emitted by the backend.',
  ],
  [
    'Time to first token p50 / p95 by model',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, model, quantile(0.5)(1000.0 * time_to_first_token) AS p50_ms, quantile(0.95)(1000.0 * time_to_first_token) AS p95_ms FROM posthog.ai_events WHERE ${assistantWhere} AND event = '$ai_generation' AND time_to_first_token IS NOT NULL GROUP BY day, model ORDER BY day`,
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
      `SELECT model_calls, count() AS turns FROM (SELECT trace_id, countIf(event = '$ai_generation') AS model_calls FROM posthog.ai_events WHERE ${assistantWhere} AND event IN ('$ai_trace', '$ai_generation') AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id HAVING countIf(event = '$ai_trace') > 0) GROUP BY model_calls ORDER BY model_calls`,
      'ActionsUnstackedBar',
      'model_calls',
      ['turns'],
    ),
    'Discrete histogram of generation attempts per explicit trace; includes zero-call turns.',
  ],
  [
    'Error and quota rate',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, 100.0 * countIf(event = '$ai_generation' AND is_error = true) / nullIf(countIf(event = '$ai_generation'), 0) AS generation_error_percent, 100.0 * uniqExactIf(trace_id, event = 'assistant_quota_hit') / nullIf(uniqExactIf(trace_id, event = '$ai_trace'), 0) AS quota_turn_percent FROM (SELECT timestamp, event, trace_id, is_error FROM posthog.ai_events WHERE ${assistantWhere} AND event IN ('$ai_generation', '$ai_trace') UNION ALL SELECT timestamp, event, ${productTraceId} AS trace_id, false AS is_error FROM events WHERE ${assistantWhere} AND event = 'assistant_quota_hit' AND ${productTraceId} IS NOT NULL) GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['generation_error_percent', 'quota_turn_percent'],
    ),
    'Generation error rate uses model calls; quota rate uses unique hit trace ids / unique completed turn trace ids. Multiple quota scopes count once per turn.',
  ],
  [
    'Fallback rate by model',
    chart(
      `SELECT model, 100.0 * countIf(${number('fallback_index')} > 0) / nullIf(count(), 0) AS fallback_percent FROM posthog.ai_events WHERE ${assistantWhere} AND event = '$ai_generation' GROUP BY model ORDER BY fallback_percent DESC`,
      'ActionsUnstackedBar',
      'model',
      ['fallback_percent'],
    ),
    'Fraction of this model’s generation attempts with fallback_index > 0.',
  ],
]);
