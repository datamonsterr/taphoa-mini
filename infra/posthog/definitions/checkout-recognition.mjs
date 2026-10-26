import { dashboard, event, property, trends } from './helpers.mjs';
export default dashboard('Checkout and recognition', [
  [
    'Scans by match class',
    trends([event('scan_completed')], {
      by: 'match_class',
      display: 'ActionsBar',
    }),
  ],
  [
    'Unknown rate',
    trends(
      [
        event('scan_completed', {
          properties: [property('match_class', 'unknown')],
        }),
        event('scan_completed'),
      ],
      { formula: '100*A/B' },
    ),
  ],
  [
    'Scan latency p95',
    trends([
      event('scan_completed', { math: 'p95', math_property: 'latency_ms' }),
    ]),
  ],
  [
    'Sales with manual lines share',
    trends(
      [
        event('sale_completed', {
          properties: [property('manual_lines', 0, 'gt')],
        }),
        event('sale_completed'),
      ],
      { formula: '100*A/B' },
    ),
  ],
  [
    'Voids per 100 sales',
    trends([event('sale_voided'), event('sale_completed')], {
      formula: '100*A/B',
    }),
  ],
]);
