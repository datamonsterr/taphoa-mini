import { event, funnel, trends } from '../definitions/helpers.mjs';
import { chart, dashboard, number, where } from './helpers.mjs';
// Voice model calls are the only generations carrying `voice_call`
// (apps/backend/crates/api/src/voice/telemetry.rs); `$ai_session_id` is the utterance id.
const voiceGeneration =
  "event = '$ai_generation' AND properties.voice_call IS NOT NULL";
// AI metrics read the posthog.ai_events columns, like the assistant dashboards.
const cost = 'coalesce(total_cost_usd, input_cost_usd + output_cost_usd)';
const drafted = `${where} AND event = 'voice_sale_drafted'`;
const result = dashboard('Voice', [
  [
    'Cost per utterance avg / p95',
    chart(
      `SELECT day, avg(utterance_cost) AS avg_cost_usd, quantile(0.95)(utterance_cost) AS p95_cost_usd FROM (SELECT toStartOfDay(min(timestamp)) AS day, properties.$ai_session_id AS utterance, sum(${cost}) AS utterance_cost FROM posthog.ai_events WHERE ${where} AND ${voiceGeneration} AND notEmpty(toString(properties.$ai_session_id)) GROUP BY utterance HAVING countIf(${cost} IS NOT NULL) > 0) GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['avg_cost_usd', 'p95_cost_usd'],
      undefined,
      { goalLines: [{ label: 'Budget: $0.002 / utterance', value: 0.002 }] },
    ),
    'USD summed over all model calls (fallbacks included) per utterance (`$ai_session_id`) before the daily average and p95. Voice generations are identified by `voice_call`. Target is the DoD row 6 budget on the default model.',
  ],
  [
    'Voice spend per day',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, sum(${cost}) AS cost_usd, uniq(properties.$ai_session_id) AS utterances FROM posthog.ai_events WHERE ${where} AND ${voiceGeneration} GROUP BY day ORDER BY day`,
      'ActionsBar',
      'day',
      ['cost_usd'],
    ),
    'Total voice model-call cost per day; utterances is the distinct `$ai_session_id` count. Missing costs are not assumed zero.',
  ],
  [
    'Utterance funnel',
    funnel([
      event('voice_sale_started'),
      event('voice_sale_drafted'),
      event('voice_sale_confirmed'),
    ]),
    'Ordered person funnel started, drafted (backend), confirmed.',
  ],
  [
    'Abandoned by stage',
    trends([event('voice_sale_abandoned')], {
      by: 'stage',
      display: 'ActionsBar',
    }),
    'Abandons by stage: listening, draft or pay.',
  ],
  [
    'Engine split',
    trends([event('voice_input_used')], {
      by: 'engine',
      display: 'ActionsPie',
    }),
    'voice_input_used by engine: device or server.',
  ],
  [
    'Draft latency p50 / p95',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, quantile(0.5)(${number('latency_ms')}) AS p50_ms, quantile(0.95)(${number('latency_ms')}) AS p95_ms FROM events WHERE ${drafted} GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['p50_ms', 'p95_ms'],
      undefined,
      { goalLines: [{ label: 'p95 budget: 3,000 ms', value: 3000 }] },
    ),
    'voice_sale_drafted.latency_ms in milliseconds, from the backend utterance start to the draft.',
  ],
  [
    'STT fallback rate',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, count() AS drafts, 100.0 * countIf(properties.stt_fallback = true) / nullIf(count(), 0) AS stt_fallback_percent FROM events WHERE ${drafted} GROUP BY day ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['stt_fallback_percent'],
    ),
    'Share of drafts where audio-native failed and the STT path ran.',
  ],
  [
    'Calls and cost by model',
    chart(
      `SELECT model, count() AS calls, countIf(${number('fallback_index')} > 0) AS fallback_calls, sum(${cost}) AS cost_usd FROM posthog.ai_events WHERE ${where} AND ${voiceGeneration} GROUP BY model ORDER BY calls DESC`,
      'ActionsBar',
      'model',
      ['calls', 'fallback_calls'],
    ),
    'Voice model calls by model, with calls served by a fallback (fallback_index > 0) and total cost.',
  ],
]);
export default result;
