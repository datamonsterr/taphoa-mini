import { describe, expect, it, vi } from 'vitest';
import {
  caseScoredProperties,
  MemorySink,
  NoopSink,
  PostHogSink,
  runCompletedProperties,
} from './posthog.ts';
import { aggregate } from './scorers/index.ts';
import { mkCase, mkTurn } from './test-helpers.ts';
import type { CaseScore } from './types.ts';

function okFetch() {
  return vi.fn<typeof fetch>(async () => new Response('{"status":1}'));
}

const NOW = new Date('2026-10-25T03:00:00.000Z');

function sink(fetchFn: typeof fetch, warn = vi.fn()) {
  return {
    warn,
    sink: new PostHogSink({
      token: 'phc_secret',
      host: 'https://us.i.posthog.com',
      fetch: fetchFn,
      now: () => NOW,
      warn,
    }),
  };
}

describe('PostHogSink', () => {
  it('posts one batch to the capture endpoint at flush', async () => {
    const fetchFn = okFetch();
    const { sink: s } = sink(fetchFn);
    s.capture('eval_case_scored', { case_id: 'U1-01', value: 1 });
    s.capture('eval_run_completed', { pass: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await s.flush()).toBe(true);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://us.i.posthog.com/batch/');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/json',
    );
    const body = JSON.parse(String(init?.body));
    expect(body.api_key).toBe('phc_secret');
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0]).toEqual({
      event: 'eval_case_scored',
      distinct_id: 'eval-harness',
      properties: {
        distinct_id: 'eval-harness',
        environment: 'eval',
        $process_person_profile: false,
        case_id: 'U1-01',
        value: 1,
      },
      timestamp: '2026-10-25T03:00:00.000Z',
    });
    expect(body.batch[1].event).toBe('eval_run_completed');
  });

  it('accepts a host with a trailing slash', async () => {
    const fetchFn = okFetch();
    const s = new PostHogSink({
      token: 't',
      host: 'https://eu.i.posthog.com/',
      fetch: fetchFn,
      warn: () => {},
    });
    s.capture('e', {});
    await s.flush();
    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'https://eu.i.posthog.com/batch/',
    );
  });

  it('does not call the network when nothing was captured', async () => {
    const fetchFn = okFetch();
    expect(await sink(fetchFn).sink.flush()).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('clears the buffer after a flush', async () => {
    const fetchFn = okFetch();
    const { sink: s } = sink(fetchFn);
    s.capture('e', {});
    await s.flush();
    await s.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('splits a large buffer into several batches', async () => {
    const fetchFn = okFetch();
    const s = new PostHogSink({
      token: 't',
      fetch: fetchFn,
      batchSize: 2,
      warn: () => {},
    });
    for (let i = 0; i < 5; i++) s.capture('e', { i });
    await s.flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('defaults the host to US cloud', async () => {
    const fetchFn = okFetch();
    const s = new PostHogSink({ token: 't', fetch: fetchFn, warn: () => {} });
    s.capture('e', {});
    await s.flush();
    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'https://us.i.posthog.com/batch/',
    );
  });

  it('warns and returns false when the request fails, without the token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network down');
    });
    const { sink: s, warn } = sink(fetchFn);
    s.capture('e', {});
    await expect(s.flush()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('network down');
    expect(String(warn.mock.calls[0]![0])).not.toContain('phc_secret');
  });

  it('warns and returns false on an HTTP error status', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response('bad key', { status: 401 }),
    );
    const { sink: s, warn } = sink(fetchFn);
    s.capture('e', {});
    await expect(s.flush()).resolves.toBe(false);
    expect(String(warn.mock.calls[0]![0])).toContain('401');
    expect(String(warn.mock.calls[0]![0])).not.toContain('phc_secret');
  });
});

describe('MemorySink and NoopSink', () => {
  it('MemorySink records events in order', async () => {
    const s = new MemorySink();
    s.capture('a', { x: 1 });
    s.capture('b', { y: 2 });
    expect(await s.flush()).toBe(true);
    expect(s.events).toEqual([
      { event: 'a', properties: { x: 1 } },
      { event: 'b', properties: { y: 2 } },
    ]);
  });

  it('NoopSink drops everything', async () => {
    const s = new NoopSink();
    s.capture('a', {});
    expect(await s.flush()).toBe(true);
  });
});

describe('event properties', () => {
  const ctx = {
    runId: 'eval-20261025T1015-ab12',
    model: 'google/gemma-4-31b-it:free',
    set: 'smoke' as const,
    judgeModel: 'nvidia/nemotron-3-super-120b-a12b:free',
  };

  it('eval_case_scored carries run, case and scorer fields', () => {
    const c = mkCase({
      id: 'U3-02',
      use_case: 'U3',
      tags: ['smoke', 'permission'],
    });
    const score: CaseScore = {
      case_id: 'U3-02',
      use_case: 'U3',
      scorer: 'facts',
      value: 0.5,
    };
    expect(caseScoredProperties(ctx, c, score)).toEqual({
      eval_run_id: 'eval-20261025T1015-ab12',
      model: 'google/gemma-4-31b-it:free',
      case_id: 'U3-02',
      use_case: 'U3',
      scorer: 'facts',
      value: 0.5,
      set: 'smoke',
      judge_model: 'nvidia/nemotron-3-super-120b-a12b:free',
      tags: ['smoke', 'permission'],
    });
  });

  it('eval_run_completed flattens every metric with a pass flag', () => {
    const c = mkCase({
      id: 'U1-01',
      expect_facts: [{ oracle: 'x', match: 'number' }],
    });
    const turn = mkTurn({ latency_ms: 4000 });
    const agg = aggregate([
      {
        case: c,
        turn,
        scores: [
          {
            case_id: 'U1-01',
            use_case: 'U1',
            scorer: 'tool_selection',
            value: 1,
          },
          { case_id: 'U1-01', use_case: 'U1', scorer: 'facts', value: 0.5 },
          { case_id: 'U1-01', use_case: 'U1', scorer: 'judge', value: 5 },
        ],
      },
    ]);
    const props = runCompletedProperties({
      ...ctx,
      cases: 1,
      errors: 0,
      pending: 2,
      aggregate: agg,
      gitSha: 'abc1234',
      resultsFile: '2026-10-25-x-smoke.md',
    });
    expect(props).toMatchObject({
      eval_run_id: 'eval-20261025T1015-ab12',
      model: 'google/gemma-4-31b-it:free',
      set: 'smoke',
      judge_model: 'nvidia/nemotron-3-super-120b-a12b:free',
      cases: 1,
      errors: 0,
      pending: 2,
      pass: false,
      git_sha: 'abc1234',
      results_file: '2026-10-25-x-smoke.md',
      tool_selection: 1,
      tool_selection_pass: true,
      facts: 0.5,
      facts_pass: false,
      judge: 1,
      judge_pass: true,
      action: null,
      action_pass: true,
      permission_leak: null,
      permission_leak_pass: true,
      injection_resisted: null,
      language: null,
      latency_p95_ms: 4000,
      latency_p95_ms_pass: true,
    });
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['injection_resisted_pass', 'language_pass']),
    );
  });
});
