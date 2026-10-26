import { dashboard, event, trends, hogql, eventWhere } from './helpers.mjs';
export default dashboard('Product overview', [
  [
    'DAU / WAU / MAU',
    trends(
      ['dau', 'weekly_active', 'monthly_active'].map((math) =>
        event('$screen', { math }),
      ),
    ),
    'Unique persons viewing screens; rolling daily, weekly and monthly activity.',
  ],
  [
    'Active stores',
    trends([
      event('sale_completed', {
        math: 'unique_group',
        math_group_type_index: 0,
      }),
    ]),
    'Requires store group type index 0.',
  ],
  [
    'New stores per week',
    trends([event('store_created')], {
      interval: 'week',
      display: 'ActionsBar',
    }),
  ],
  [
    'Week-1 and week-4 retention',
    {
      kind: 'InsightVizNode',
      source: {
        kind: 'RetentionQuery',
        dateRange: { date_from: '-60d' },
        retentionFilter: {
          targetEntity: {
            id: 'sale_completed',
            type: 'events',
            name: 'sale_completed',
          },
          returningEntity: {
            id: 'sale_completed',
            type: 'events',
            name: 'sale_completed',
          },
          retentionType: 'retention_first_time',
          period: 'Week',
          totalIntervals: 5,
        },
      },
    },
    'First-sale cohorts, weeks 0–4; inspect week 1 and week 4.',
  ],
  [
    'Stickiness',
    {
      kind: 'InsightVizNode',
      source: {
        kind: 'StickinessQuery',
        series: [event('sale_completed')],
        dateRange: { date_from: '-30d' },
        interval: 'day',
      },
    },
  ],
  [
    'Sales per active store per day',
    trends(
      [
        event('sale_completed'),
        event('sale_completed', {
          math: 'unique_group',
          math_group_type_index: 0,
        }),
      ],
      { formula: 'A/B' },
    ),
  ],
  [
    'Revenue per day',
    trends([event('sale_completed', { math: 'sum', math_property: 'total' })]),
    'Revenue in integer đồng.',
  ],
  [
    'Payment method mix including credit',
    hogql(
      `SELECT properties.environment AS environment, properties.payment_method AS payment_method, properties.has_credit AS has_credit, count() AS sales FROM events WHERE ${eventWhere} AND event = 'sale_completed' GROUP BY environment, payment_method, has_credit ORDER BY sales DESC`,
    ),
    'Split credit is visible via has_credit even when payment_method is cash or transfer.',
    ['sale_completed'],
  ],
]);
