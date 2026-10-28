import { describe, expect, it, vi } from 'vitest';
import {
  checkQuota,
  estimateRequests,
  fetchQuota,
  QuotaError,
} from './quota.ts';
import { mkCase } from './test-helpers.ts';

function keyResponse(remaining: number, limit = 1000): Response {
  return new Response(
    JSON.stringify({
      data: {
        label: 'eval',
        free_model_daily_requests: {
          used: limit - remaining,
          limit,
          remaining,
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fakeFetch(res: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => res());
}

describe('checkQuota', () => {
  it('returns the counters when enough requests remain', async () => {
    const fetchFn = fakeFetch(() => keyResponse(900));
    const quota = await checkQuota({
      apiKey: 'sk-secret',
      estimate: 300,
      fetch: fetchFn,
    });
    expect(quota).toEqual({ remaining: 900, limit: 1000, used: 100 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/key');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer sk-secret',
    );
  });

  it('accepts exactly estimate + 100 remaining', async () => {
    const quota = await checkQuota({
      apiKey: 'k',
      estimate: 300,
      fetch: fakeFetch(() => keyResponse(400)),
    });
    expect(quota.remaining).toBe(400);
  });

  it('throws QuotaError below estimate + 100', async () => {
    const err = await checkQuota({
      apiKey: 'k',
      estimate: 300,
      fetch: fakeFetch(() => keyResponse(399)),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaError);
    const quotaError = err as QuotaError;
    expect(quotaError.remaining).toBe(399);
    expect(quotaError.estimate).toBe(300);
    expect(quotaError.message).toContain('399');
    expect(quotaError.message).toContain('300');
  });

  it('fails clearly on an HTTP error, without the key', async () => {
    const err = await checkQuota({
      apiKey: 'sk-secret',
      estimate: 1,
      fetch: fakeFetch(() => new Response('nope', { status: 401 })),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(QuotaError);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('sk-secret');
  });

  it('fails clearly when the body has no counters', async () => {
    await expect(
      checkQuota({
        apiKey: 'k',
        estimate: 1,
        fetch: fakeFetch(
          () => new Response(JSON.stringify({ data: { label: 'x' } })),
        ),
      }),
    ).rejects.toThrow('free_model_daily_requests');
  });

  it('fails clearly when the request itself fails', async () => {
    await expect(
      checkQuota({
        apiKey: 'k',
        estimate: 1,
        fetch: vi.fn<typeof fetch>(async () => {
          throw new TypeError('fetch failed');
        }),
      }),
    ).rejects.toThrow('fetch failed');
  });
});

describe('fetchQuota', () => {
  it('reads the counters without a threshold', async () => {
    expect(
      await fetchQuota({ apiKey: 'k', fetch: fakeFetch(() => keyResponse(3)) }),
    ).toEqual({ remaining: 3, limit: 1000, used: 997 });
  });
});

describe('estimateRequests', () => {
  const one = mkCase({ id: 'U1-01' });
  const two = mkCase({
    id: 'U1-02',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ],
  });
  const digest = mkCase({
    id: 'U13-01',
    use_case: 'U13',
    kind: 'digest',
    messages: [],
  });

  it('counts 3 requests per user message', () => {
    expect(estimateRequests([one, two], false)).toBe(9);
  });

  it('adds one request per judged case', () => {
    expect(estimateRequests([one, two], true)).toBe(11);
  });

  it('counts a digest case as zero messages', () => {
    expect(estimateRequests([digest], false)).toBe(0);
    expect(estimateRequests([digest], true)).toBe(1);
  });

  it('is zero for no cases', () => {
    expect(estimateRequests([], true)).toBe(0);
  });
});

describe('paid budget guard', () => {
  const response = (remaining: number | null) =>
    Response.json({
      data: {
        limit: 10,
        usage: 2,
        limit_remaining: remaining,
        free_model_daily_requests: { remaining: 0, used: 1000, limit: 1000 },
      },
    });
  it('uses USD even when the free request quota is exhausted', async () => {
    expect(
      await checkQuota({
        apiKey: 'k',
        paid: true,
        estimate: 500,
        fetch: fakeFetch(() => response(8)),
      }),
    ).toEqual({ remaining: 8, limit: 10, used: 2, unit: 'USD' });
  });
  it('refuses insufficient credits and unbounded keys', async () => {
    await expect(
      checkQuota({
        apiKey: 'k',
        paid: true,
        estimate: 500,
        fetch: fakeFetch(() => response(0.2)),
      }),
    ).rejects.toThrow('credits too low');
    await expect(
      fetchQuota({
        apiKey: 'k',
        paid: true,
        fetch: fakeFetch(() => response(null)),
      }),
    ).rejects.toThrow('finite key limit');
  });
});
