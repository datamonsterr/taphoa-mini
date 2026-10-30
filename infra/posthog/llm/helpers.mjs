export const where =
  'timestamp >= now() - INTERVAL {{days}} DAY AND {{environment}}';
// Voice model calls carry `voice_call` (string kind); assistant charts must not count them.
export const assistantWhere = `${where} AND properties.voice_call IS NULL`;
export const number = (key) => `toFloat64OrNull(toString(properties.${key}))`;
export const tokens = 'coalesce(input_tokens, 0) + coalesce(output_tokens, 0)';
// Direct property access can hit an empty materialized column on non-AI events.
export const productTraceId =
  "nullIf(JSONExtractString(toString(properties), '$ai_trace_id'), '')";
export const toolWhere = "event = '$ai_span' AND span_name LIKE 'tool:%'";
export function chart(sql, display, x, ys, by, settings = {}) {
  return {
    kind: 'DataVisualizationNode',
    source: { kind: 'HogQLQuery', query: sql },
    display,
    chartSettings: {
      xAxis: { column: x },
      yAxis: ys.map((column) => ({ column })),
      ...(by ? { seriesBreakdownColumn: by } : {}),
      ...settings,
    },
  };
}
export function dashboard(name, charts) {
  return {
    name,
    description: 'X9 assistant LLM analytics. Managed by infra/posthog/llm.',
    tags: ['x9', 'llm', 'managed-as-code'],
    pinned: true,
    insights: charts.map(([title, query, description, scope]) => ({
      name: `${name} · ${title}`,
      query,
      description,
      tags: ['x9', 'llm', 'managed-as-code'],
      ...(scope ? { scope } : {}),
    })),
  };
}
