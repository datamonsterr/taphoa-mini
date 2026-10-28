/**
 * Cost of one utterance in USD, when the response carries it (`cost_usd`, `cost` or
 * `usage.cost`). The contract has no such field yet: then this is null and the cost
 * is read later from PostHog (`fetchPostHogCosts`).
 */
export function costFromResponse(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    cost_usd?: unknown;
    cost?: unknown;
    usage?: { cost?: unknown };
  };
  for (const v of [b.cost_usd, b.cost, b.usage?.cost]) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Property of `$ai_generation` that holds the cost of the model call. */
export const COST_PROPERTY = '$ai_total_cost_usd';

/**
 * Sum the `$ai_generation` cost per utterance (`$ai_session_id` = utterance id) with a
 * HogQL query. Needs a personal API key and the project id. Utterances PostHog has not
 * ingested yet are missing from the result. Throws on an HTTP failure.
 */
export async function fetchPostHogCosts(opts: {
  host: string;
  projectId: string;
  personalApiKey: string;
  utteranceIds: string[];
  fetch?: typeof fetch;
}): Promise<Map<string, number>> {
  const ids = opts.utteranceIds.filter((id) => UUID.test(id));
  const costs = new Map<string, number>();
  if (ids.length === 0) return costs;
  const list = ids.map((id) => `'${id.toLowerCase()}'`).join(', ');
  const query =
    `SELECT properties.$ai_session_id AS session, sum(toFloat(properties.${COST_PROPERTY})) AS cost ` +
    `FROM events WHERE event = '$ai_generation' AND timestamp > now() - INTERVAL 7 DAY ` +
    `AND properties.$ai_session_id IN (${list}) GROUP BY session`;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const res = await fetchFn(
    `${opts.host.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(opts.projectId)}/query/`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.personalApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`PostHog cost query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { results?: [unknown, unknown][] };
  for (const [session, cost] of body.results ?? []) {
    if (typeof session === 'string' && typeof cost === 'number')
      costs.set(session.toLowerCase(), cost);
  }
  return costs;
}
