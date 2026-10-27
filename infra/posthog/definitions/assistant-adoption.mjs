import { dashboard, event, trends, hogql, eventWhere } from './helpers.mjs';
export default dashboard('Assistant adoption', [
  [
    'Opens by entry',
    trends([event('assistant_opened')], { by: 'entry', display: 'ActionsBar' }),
  ],
  [
    'Weekly users sending a message',
    trends([event('assistant_message_sent', { math: 'dau' })], {
      interval: 'week',
      display: 'ActionsBar',
    }),
    'Unique persons within each calendar week.',
  ],
  [
    'Messages per user',
    trends(
      [
        event('assistant_message_sent'),
        event('assistant_message_sent', { math: 'dau' }),
      ],
      { formula: 'A/B' },
    ),
  ],
  [
    'Action confirm rate by kind',
    hogql(
      `SELECT properties.environment AS environment, properties.kind AS kind, countIf(properties.decision = 'confirmed') AS confirmed, count() AS decisions, 100.0 * confirmed / nullIf(decisions, 0) AS confirm_percent FROM events WHERE ${eventWhere} AND event = 'assistant_action_decided' GROUP BY environment, kind`,
    ),
    '',
    ['assistant_action_decided'],
  ],
  [
    'Feedback ratio',
    trends([event('assistant_feedback_given')], {
      by: 'rating',
      display: 'ActionsPie',
    }),
    'Distribution of feedback ratings.',
  ],
  [
    'Next-step CTR by kind and position',
    hogql(
      `SELECT properties.environment AS environment, properties.kind AS kind, properties.position AS position, countIf(event = 'next_step_shown') AS shown, countIf(event = 'next_step_tapped') AS tapped, 100.0 * tapped / nullIf(shown, 0) AS ctr_percent FROM events WHERE ${eventWhere} AND event IN ('next_step_shown', 'next_step_tapped') GROUP BY environment, kind, position`,
    ),
    '',
    ['next_step_shown', 'next_step_tapped'],
  ],
  [
    'Voice input share and success',
    hogql(
      `SELECT properties.environment AS environment, countIf(event = 'assistant_message_sent') AS messages, countIf(event = 'assistant_message_sent' AND properties.input = 'voice') AS voice_messages, 100.0 * voice_messages / nullIf(messages, 0) AS voice_share_percent, countIf(event = 'voice_input_used') AS voice_attempts, countIf(event = 'voice_input_used' AND properties.ok = true) AS voice_successes, 100.0 * voice_successes / nullIf(voice_attempts, 0) AS success_percent FROM events WHERE ${eventWhere} AND event IN ('assistant_message_sent', 'voice_input_used') GROUP BY environment`,
    ),
    '',
    ['assistant_message_sent', 'voice_input_used'],
  ],
  [
    'Digest open rate (card vs push)',
    trends([event('digest_opened')], { by: 'entry', display: 'ActionsPie' }),
    'Open shares by entry only. The contract has no digest impression/delivery event, so a true exposure-to-open rate is unavailable.',
  ],
]);
