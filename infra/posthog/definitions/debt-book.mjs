import {
  dashboard,
  event,
  property,
  trends,
  hogql,
  eventWhere,
} from './helpers.mjs';
export default dashboard('Debt book', [
  [
    'Credit sales share',
    trends(
      [
        event('sale_completed', { properties: [property('has_credit', true)] }),
        event('sale_completed'),
      ],
      { formula: '100*A/B' },
    ),
  ],
  [
    'Debts recorded vs repaid per week',
    hogql(
      `SELECT toStartOfWeek(timestamp) AS week, properties.environment AS environment, event, properties.amount_bucket AS amount_bucket, count() AS entries FROM events WHERE ${eventWhere} AND event IN ('debt_recorded', 'debt_repaid') GROUP BY week, environment, event, amount_bucket ORDER BY week`,
    ),
    'Counts by amount bucket; exact debt amounts are not captured.',
    ['debt_recorded', 'debt_repaid'],
  ],
  [
    'Customers created',
    trends([event('customer_created')], { display: 'BoldNumber' }),
  ],
  [
    'Overdue reminder shares',
    trends(
      [
        event('next_step_shown', {
          properties: [property('kind', 'overdue_debts')],
        }),
        event('next_step_shown'),
      ],
      { formula: '100*A/B' },
    ),
    'Share of next-step impressions that are overdue reminders.',
  ],
]);
