import { hogql } from '../definitions/helpers.mjs';
import { productTraceId, where } from './helpers.mjs';
// PostHog's DataTable saved filters are browser-local, not a REST resource.
// Shared saved insights provide durable named filters through the Insights API.
export const traceFilters = [
  [
    'Errors',
    'posthog.ai_events',
    'trace_id',
    "event IN ('$ai_trace', '$ai_generation', '$ai_span') AND is_error = true",
    'Any errored turn, generation or tool span',
  ],
  [
    'Quota hits',
    'events',
    productTraceId,
    "event = 'assistant_quota_hit'",
    'Turns linked to a quota hit in any scope',
  ],
  [
    'Rejected actions',
    'events',
    productTraceId,
    "event = 'assistant_action_decided' AND properties.decision = 'rejected'",
    'Turns linked to a rejected proposed action',
  ],
].map(([title, table, traceId, predicate, description]) => ({
  name: `Assistant traces · ${title}`,
  description: `${description}. Shared saved trace filter; open the returned trace_id in LLM analytics. Native DataTable saved filters are browser-local and have no REST endpoint.`,
  favorited: true,
  tags: ['x9', 'llm', 'trace-filter', 'managed-as-code'],
  query: hogql(
    `SELECT ${traceId} AS trace_id, min(timestamp) AS first_match, count() AS matching_events FROM ${table} WHERE ${where} AND ${predicate} AND ${traceId} IS NOT NULL AND ${traceId} != '' GROUP BY trace_id ORDER BY first_match DESC LIMIT 100`,
  ),
}));
