export const property = (key, value, operator = 'exact') => ({
  type: 'event',
  key,
  value,
  operator,
});
export const event = (name, options = {}) => ({
  kind: 'EventsNode',
  event: name,
  name,
  math: 'total',
  ...options,
});
export const breakdown = (key = 'environment') => ({
  breakdown: key,
  breakdown_type: 'event',
});
export function trends(
  series,
  {
    display = 'ActionsLineGraph',
    by = 'environment',
    interval = 'day',
    formula,
  } = {},
) {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'TrendsQuery',
      series,
      interval,
      dateRange: { date_from: '-30d' },
      ...(by ? { breakdownFilter: breakdown(by) } : {}),
      trendsFilter: { display, ...(formula ? { formula } : {}) },
    },
  };
}
export function funnel(series, by) {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'FunnelsQuery',
      series,
      dateRange: { date_from: '-30d' },
      funnelsFilter: {
        funnelVizType: 'steps',
        funnelWindowInterval: 14,
        funnelWindowIntervalUnit: 'day',
        ...(by
          ? {
              breakdownAttributionType: 'step',
              breakdownAttributionValue: series.length - 1,
            }
          : {}),
      },
      ...(by ? { breakdownFilter: breakdown(by) } : {}),
    },
  };
}
export function hogql(query) {
  return { kind: 'DataTableNode', source: { kind: 'HogQLQuery', query } };
}
export const eventWhere =
  'timestamp >= now() - INTERVAL {{days}} DAY AND {{environment}}';
export function dashboard(name, charts) {
  return {
    name,
    description:
      'X6 product analytics. Includes all environments; managed by infra/posthog.',
    tags: ['x6', 'managed-as-code'],
    pinned: true,
    insights: charts.map(([title, query, description = '', events = []]) => ({
      name: `${name} · ${title}`,
      description,
      query,
      events,
      tags: ['x6', 'managed-as-code'],
    })),
  };
}
