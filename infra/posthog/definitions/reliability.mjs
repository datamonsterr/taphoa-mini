import { dashboard, event, trends, hogql, eventWhere } from './helpers.mjs';
const logsWhere =
  "timestamp >= now() - INTERVAL {{days}} DAY AND resource_attributes['service.name'] = 'taphoa-backend' AND {{environment}}";
export default dashboard('Reliability', [
  ['Exceptions trend', trends([event('$exception')])],
  [
    'Crash-free sessions',
    hogql(
      `SELECT environment, 100.0 * countIf(errors = 0) / nullIf(count(), 0) AS crash_free_percent, count() AS screen_sessions FROM (SELECT properties.environment AS environment, properties.$session_id AS session_id, countIf(event = '$screen') AS screens, countIf(event = '$exception') AS errors FROM events WHERE ${eventWhere} AND event IN ('$screen', '$exception') AND properties.$session_id IS NOT NULL GROUP BY environment, session_id HAVING screens > 0) GROUP BY environment`,
    ),
    'Sessions with screens and no captured exception, divided by sessions with screens.',
    ['$screen', '$exception'],
  ],
  [
    'Backend error logs per route',
    hogql(
      `SELECT resource_attributes['deployment.environment.name'] AS environment, attributes['http.route'] AS route, count() AS errors FROM logs WHERE ${logsWhere} AND lower(severity_text) IN ('error', 'fatal') GROUP BY environment, route ORDER BY errors DESC`,
    ),
  ],
  [
    'API p95 per route',
    hogql(
      `SELECT resource_attributes['deployment.environment.name'] AS environment, attributes['http.route'] AS route, quantile(0.95)(toFloat64OrNull(toString(attributes['duration_ms']))) AS p95_ms, count() AS requests FROM logs WHERE ${logsWhere} AND body = 'request completed' AND attributes['duration_ms'] IS NOT NULL GROUP BY environment, route ORDER BY p95_ms DESC`,
    ),
  ],
  [
    '5xx rate',
    hogql(
      `SELECT resource_attributes['deployment.environment.name'] AS environment, attributes['http.route'] AS route, count() AS requests, countIf(toFloat64OrNull(toString(attributes['http.response.status_code'])) >= 500) AS errors_5xx, 100.0 * errors_5xx / nullIf(requests, 0) AS error_percent FROM logs WHERE ${logsWhere} AND body = 'request completed' AND attributes['http.response.status_code'] IS NOT NULL GROUP BY environment, route ORDER BY error_percent DESC`,
    ),
  ],
]);
