import { event, funnel, property } from '../definitions/helpers.mjs';
import { chart, dashboard, number, toolWhere, where } from './helpers.mjs';
const result = dashboard('Tools and actions', [
  [
    'Tool calls per day by tool',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.$ai_span_name AS tool, count() AS calls FROM events WHERE ${where} AND ${toolWhere} GROUP BY day, tool ORDER BY day`,
      'ActionsStackedBar',
      'day',
      ['calls'],
      'tool',
    ),
    'Only tool:<name> spans enter tool metrics.',
  ],
  [
    'Tool error and denied rate by tool',
    chart(
      `SELECT properties.$ai_span_name AS tool, 100.0 * countIf(properties.$ai_is_error = true) / nullIf(count(), 0) AS error_percent, 100.0 * countIf(properties.denied = true) / nullIf(count(), 0) AS denied_percent FROM events WHERE ${where} AND ${toolWhere} GROUP BY tool ORDER BY error_percent DESC`,
      'ActionsUnstackedBar',
      'tool',
      ['error_percent', 'denied_percent'],
    ),
    'Both rates use all calls to that tool as denominator. Denied calls are also errors, as emitted.',
  ],
  [
    'Tool latency p95 by tool',
    chart(
      `SELECT properties.$ai_span_name AS tool, quantile(0.95)(${number('$ai_latency')}) AS p95_seconds FROM events WHERE ${where} AND ${toolWhere} AND properties.$ai_latency IS NOT NULL GROUP BY tool ORDER BY p95_seconds DESC`,
      'ActionsUnstackedBar',
      'tool',
      ['p95_seconds'],
    ),
    'Tool latency in seconds.',
  ],
  [
    'Use-case mix',
    chart(
      `SELECT use_case, count() AS turns FROM (SELECT arrayJoin(JSONExtractArrayRaw(toString(properties.use_cases))) AS raw_use_case, trim(BOTH '"' FROM raw_use_case) AS use_case FROM events WHERE ${where} AND event = '$ai_trace') GROUP BY use_case ORDER BY turns DESC`,
      'ActionsPie',
      'use_case',
      ['turns'],
    ),
    'Explodes the emitted use_cases array: a multi-use-case turn contributes to each case. Empty arrays contribute no case.',
  ],
  [
    'Proposed action outcomes by kind',
    chart(
      `SELECT properties.kind AS kind, properties.decision AS decision, count() AS actions FROM events WHERE ${where} AND event = 'assistant_action_decided' GROUP BY kind, decision ORDER BY kind, decision`,
      'ActionsStackedBar',
      'kind',
      ['actions'],
      'decision',
    ),
    'Recorded decisions by action kind; includes confirmed, rejected, expired and failed when emitted.',
  ],
  [
    'Next-step turns by kind',
    chart(
      `SELECT properties.next_step_kind AS kind, count() AS turns FROM events WHERE ${where} AND event = '$ai_trace' AND properties.next_step_kind IS NOT NULL GROUP BY kind ORDER BY turns DESC`,
      'ActionsUnstackedBar',
      'kind',
      ['turns'],
    ),
    'Chip-attributed turn counts use the backend next_step_kind property.',
  ],
  [
    'Next-step chip to turn',
    funnel(
      [
        event('next_step_tapped'),
        event('$ai_trace', { properties: [property('entry', 'chip')] }),
      ],
      'kind',
    ),
    'Ordered person funnel within 30 minutes, broken down by tapped kind. Aggregate conversion, not exact chip attribution: mobile tap and backend trace have no shared chip id. See adjacent next_step_kind counts.',
  ],
]);
// A tap normally opens the turn immediately; avoid the generic 14-day funnel window.
const filter = result.insights.at(-1).query.source.funnelsFilter;
filter.funnelWindowInterval = 30;
filter.funnelWindowIntervalUnit = 'minute';
filter.breakdownAttributionValue = 0;
export default result;
