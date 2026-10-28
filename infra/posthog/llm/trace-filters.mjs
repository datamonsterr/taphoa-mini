import { hogql } from '../definitions/helpers.mjs';
import { where } from './helpers.mjs';
// PostHog's DataTable saved filters are browser-local, not a REST resource.
// Shared saved insights provide durable named filters through the Insights API.
export const traceFilters = [
  [
    'Errors',
    "event IN ('$ai_trace', '$ai_generation', '$ai_span') AND properties.$ai_is_error = true",
    'Any errored turn, generation or tool span',
  ],
  [
    'Quota hits',
    "event = 'assistant_quota_hit'",
    'Turns linked to a quota hit in any scope',
  ],
  [
    'Rejected actions',
    "event = 'assistant_action_decided' AND properties.decision = 'rejected'",
    'Turns linked to a rejected proposed action',
  ],
].map(([title, predicate, description]) => ({
  name: `Assistant traces · ${title}`,
  description: `${description}. Shared saved trace filter; open the returned trace_id in LLM analytics. Native DataTable saved filters are browser-local and have no REST endpoint.`,
  favorited: true,
  tags: ['x9', 'llm', 'trace-filter', 'managed-as-code'],
  query: hogql(
    `SELECT properties.$ai_trace_id AS trace_id, min(timestamp) AS first_match, count() AS matching_events FROM events WHERE ${where} AND ${predicate} AND properties.$ai_trace_id IS NOT NULL GROUP BY trace_id ORDER BY first_match DESC LIMIT 100`,
  ),
}));
