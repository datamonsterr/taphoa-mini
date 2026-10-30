import { describe, expect, it, vi } from 'vitest';
import { costFromResponse, fetchPostHogCosts } from './cost.ts';

describe('costFromResponse', () => {
  it('reads cost_usd, cost and usage.cost', () => {
    expect(costFromResponse({ cost_usd: 0.001 })).toBe(0.001);
    expect(costFromResponse({ cost: 0.002 })).toBe(0.002);
    expect(costFromResponse({ usage: { cost: 0.0004 } })).toBe(0.0004);
  });
  it('is null when absent or malformed', () => {
    expect(costFromResponse({ id: 'x' })).toBeNull();
    expect(costFromResponse({ cost: -1 })).toBeNull();
    expect(costFromResponse({ cost: '0.1' })).toBeNull();
    expect(costFromResponse(null)).toBeNull();
  });
});

describe('fetchPostHogCosts', () => {
  const id = '0192f2c6-1111-7000-8000-000000000001';
  it('queries $ai_generation by session id and maps the rows', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ results: [[id, 0.0012]] }),
    );
    const costs = await fetchPostHogCosts({
      host: 'https://eu.posthog.test/',
      projectId: '42',
      personalApiKey: 'phx_secret',
      utteranceIds: [id, "x'; DROP TABLE events; --"],
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(costs.get(id)).toBe(0.0012);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://eu.posthog.test/api/projects/42/query/');
    const body = JSON.parse(init.body as string);
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.query).toContain("event = '$ai_generation'");
    expect(body.query.query).toContain(id);
    expect(body.query.query).not.toContain('DROP');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer phx_secret',
    );
  });
  it('skips the call without ids and throws on HTTP errors', async () => {
    const fetchMock = vi.fn(async () => new Response('no', { status: 401 }));
    const f = fetchMock as unknown as typeof fetch;
    const base = {
      host: 'https://h',
      projectId: '1',
      personalApiKey: 'k',
      fetch: f,
    };
    expect((await fetchPostHogCosts({ ...base, utteranceIds: [] })).size).toBe(
      0,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      fetchPostHogCosts({ ...base, utteranceIds: [id] }),
    ).rejects.toThrow('HTTP 401');
  });
});
