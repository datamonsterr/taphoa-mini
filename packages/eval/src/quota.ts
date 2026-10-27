import type { GoldenCase } from './types.ts';

export const KEY_URL = 'https://openrouter.ai/api/v1/key';
/** Requests kept in reserve above a run's estimate. */
export const QUOTA_RESERVE = 100;

export type Quota = { remaining: number; limit: number; used: number };

/** The free-model daily quota is too low for this run. */
export class QuotaError extends Error {
  readonly remaining: number;
  readonly limit: number;
  readonly used: number;
  readonly estimate: number;

  constructor(quota: Quota, estimate: number) {
    super(
      `OpenRouter free quota too low: ${quota.remaining} of ${quota.limit} requests remain today, ` +
        `the run needs about ${estimate} plus ${QUOTA_RESERVE} spare. It resets at 00:00 UTC.`,
    );
    this.name = 'QuotaError';
    this.remaining = quota.remaining;
    this.limit = quota.limit;
    this.used = quota.used;
    this.estimate = estimate;
  }
}

type KeyBody = {
  data?: {
    free_model_daily_requests?: Partial<Record<keyof Quota, unknown>>;
  };
};

/** Read the counters of `GET /api/v1/key`; throws on any failure. */
export async function fetchQuota(opts: {
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<Quota> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(KEY_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
  } catch (e) {
    throw new Error(`OpenRouter quota check failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`OpenRouter quota check failed: HTTP ${res.status}`);
  }
  let body: KeyBody;
  try {
    body = (await res.json()) as KeyBody;
  } catch {
    throw new Error('OpenRouter quota check failed: the reply is not JSON');
  }
  const counters = body.data?.free_model_daily_requests;
  const { remaining, limit, used } = counters ?? {};
  if (
    typeof remaining !== 'number' ||
    typeof limit !== 'number' ||
    typeof used !== 'number'
  ) {
    throw new Error(
      'OpenRouter quota check failed: data.free_model_daily_requests is missing from the reply',
    );
  }
  return { remaining, limit, used };
}

/**
 * Refuse to start a run the free quota cannot carry: throws `QuotaError`
 * when fewer than `estimate + 100` requests remain.
 */
export async function checkQuota(opts: {
  apiKey: string;
  estimate: number;
  fetch?: typeof fetch;
}): Promise<Quota> {
  const quota = await fetchQuota(opts);
  if (quota.remaining < opts.estimate + QUOTA_RESERVE) {
    throw new QuotaError(quota, opts.estimate);
  }
  return quota;
}

/**
 * OpenRouter requests a run costs: 3 per user message (model calls in the
 * agent loop, fallbacks and retries included) plus 1 per judged case.
 */
export function estimateRequests(cases: GoldenCase[], judged: boolean): number {
  const messages = cases.reduce((n, c) => n + c.messages.length, 0);
  return 3 * messages + (judged ? cases.length : 0);
}
