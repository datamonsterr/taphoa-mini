import {
  dashboard,
  event,
  trends,
  funnel,
  hogql,
  eventWhere,
} from './helpers.mjs';
export default dashboard('Receipts and stock', [
  [
    'Scan to confirmation by via',
    funnel([event('receipt_scanned'), event('receipt_confirmed')], 'via'),
    'via is on the confirmation event; attribute breakdown to step 2.',
  ],
  [
    'Receipt lines matched share',
    trends(
      [
        event('receipt_scanned', {
          math: 'sum',
          math_property: 'matched_lines',
        }),
        event('receipt_scanned', { math: 'sum', math_property: 'line_count' }),
      ],
      { formula: '100*A/B' },
    ),
  ],
  [
    'Stock adjustments by reason and via',
    hogql(
      `SELECT properties.environment AS environment, properties.reason AS reason, properties.via AS via, count() AS adjustments FROM events WHERE ${eventWhere} AND event = 'stock_adjusted' GROUP BY environment, reason, via ORDER BY adjustments DESC`,
    ),
    '',
    ['stock_adjusted'],
  ],
]);
