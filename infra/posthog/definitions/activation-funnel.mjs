import { dashboard, hogql, eventWhere } from './helpers.mjs';
// Enrollment events count products; reference_count counts photos and is not a funnel threshold.
const stages = `WITH activity AS (
 SELECT person_id, properties.environment AS environment,
 minIf(timestamp, event = 'signed_in') AS signed_at,
 argMinIf(properties.method, timestamp, event = 'signed_in') AS method,
 groupArrayIf(timestamp, event = 'store_created') AS stores,
 groupArrayIf(timestamp, event = 'product_enrolled') AS products,
 groupArrayIf(timestamp, event = 'sale_completed') AS sales,
 groupArrayIf(timestamp, event = 'day_closed') AS closes
 FROM events WHERE ${eventWhere}
 AND event IN ('signed_in', 'store_created', 'product_enrolled', 'sale_completed', 'day_closed')
 GROUP BY person_id, environment HAVING countIf(event = 'signed_in') > 0
), store_step AS (
 SELECT *, arrayElement(arraySort(arrayFilter(t -> t >= signed_at, stores)), 1) AS store_at FROM activity
), product_step AS (
 SELECT *, arrayElement(arraySort(arrayFilter(t -> t >= store_at, products)), 3) AS enrolled_at FROM store_step
), sale_step AS (
 SELECT *, arrayElement(arraySort(arrayFilter(t -> t >= enrolled_at, sales)), 1) AS sold_at FROM product_step
), final_step AS (
 SELECT *, arrayElement(arraySort(arrayFilter(t -> t >= sold_at, closes)), 1) AS closed_at FROM sale_step
)
`;
const valid = (step) =>
  `${step} >= signed_at AND ${step} <= signed_at + INTERVAL 14 DAY`;
const events = [
  'signed_in',
  'store_created',
  'product_enrolled',
  'sale_completed',
  'day_closed',
];
export default dashboard('Activation funnel', [
  [
    'Conversion by sign-in method',
    hogql(
      `${stages} SELECT environment, method, count() AS signed_in, countIf(${valid('store_at')}) AS store_created, countIf(${valid('store_at')} AND ${valid('enrolled_at')}) AS enrolled_three_products, countIf(${valid('store_at')} AND ${valid('enrolled_at')} AND ${valid('sold_at')}) AS sale_completed, countIf(${valid('store_at')} AND ${valid('enrolled_at')} AND ${valid('sold_at')} AND ${valid('closed_at')}) AS day_closed, 100.0 * day_closed / nullIf(signed_in, 0) AS conversion_percent FROM final_step GROUP BY environment, method`,
    ),
    'Ordered person funnel within 14 days; third product enrollment is required.',
    events,
  ],
  [
    'Time to convert by sign-in method',
    hogql(
      `${stages} SELECT environment, method, avg(dateDiff('second', signed_at, closed_at)) / 3600 AS mean_hours, quantile(0.95)(dateDiff('second', signed_at, closed_at)) / 3600 AS p95_hours, count() AS converted FROM final_step WHERE ${valid('store_at')} AND ${valid('enrolled_at')} AND ${valid('sold_at')} AND ${valid('closed_at')} GROUP BY environment, method`,
    ),
    'Only completed ordered funnels; hours from sign-in to day close.',
    events,
  ],
]);
