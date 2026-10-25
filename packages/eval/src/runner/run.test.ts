import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeJudge, type JudgeFn } from '../judge/judge.ts';
import { FakeOracle, type OracleProvider } from '../oracle/provider.ts';
import { MemorySink, type EventSink } from '../posthog.ts';
import { QuotaError } from '../quota.ts';
import type { GoldenCase } from '../types.ts';
import { EnvAuth, StubAuth } from './auth.ts';
import { loadFixtureCases } from './fixtures.ts';
import {
  CaseLoadError,
  FullRunExistsError,
  runEval,
  type RunEvalOptions,
} from './run.ts';
import {
  badScript,
  perfectScript,
  startStubAssistant,
  type StubHandle,
  type StubRequest,
  type StubScript,
} from './stub-assistant.ts';

const NOW = new Date('2026-10-25T03:15:00.000Z'); // 10:15 on 2026-10-25 in Ho Chi Minh City
const cases = loadFixtureCases();
const oracle = new FakeOracle();

let stub: StubHandle | null = null;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-run-'));
});
afterEach(async () => {
  await stub?.close();
  stub = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(script: StubScript) {
  stub = await startStubAssistant(script);
  return stub;
}

function opts(over: Partial<RunEvalOptions> = {}): RunEvalOptions {
  return {
    set: 'smoke',
    cases,
    baseUrl: stub!.url,
    auth: new StubAuth(),
    oracle,
    judge: fakeJudge(5),
    sink: new MemorySink(),
    outDir: dir,
    quota: null,
    retryDelayMs: 0,
    now: () => NOW,
    gitSha: 'abc1234',
    log: () => {},
    ...over,
  };
}

/** The perfect script, except for requests the override answers itself. */
function perfectWith(
  override: (req: StubRequest) => ReturnType<StubScript['reply']> | undefined,
): StubScript {
  const base = perfectScript(cases, oracle);
  return {
    ...base,
    reply: async (req) => (await override(req)) ?? base.reply(req),
  };
}

const messageCalls = (handle: StubHandle) =>
  handle.calls.filter((c) => c.path.endsWith('/messages'));
const contentOf = (call: { body: unknown }) =>
  (call.body as { content: string }).content;

describe('runEval with the perfect stub', () => {
  it('passes every bar and writes the results file', async () => {
    await start(perfectScript(cases, oracle));
    const sink = new MemorySink();
    const run = await runEval(opts({ sink }));

    expect(run.pass).toBe(true);
    expect(run.aggregate.pass).toBe(true);
    expect(run.aggregate.errors).toEqual([]);
    expect(run.aborted).toBeNull();
    expect(run.set).toBe('smoke');
    expect(run.runId).toMatch(/^eval-20261025T0315-[0-9a-f]{4}$/);
    expect(run.model).toBe('stub/perfect-model');
    expect(basename(run.resultsFile)).toBe(
      '2026-10-25-stub-perfect-model-smoke.md',
    );
    const md = readFileSync(run.resultsFile, 'utf8');
    expect(md).toContain(run.runId);
    expect(md).toContain('abc1234');

    const smoke = cases.filter((c) => c.tags.includes('smoke'));
    expect(run.results.map((r) => r.case.id)).toEqual(smoke.map((c) => c.id));
  });

  it('sends one event per score, then the run summary, and flushes', async () => {
    await start(perfectScript(cases, oracle));
    const sink = new MemorySink();
    const run = await runEval(opts({ sink }));

    const scored = sink.events.filter((e) => e.event === 'eval_case_scored');
    const expected = run.results.reduce((n, r) => n + r.scores.length, 0);
    expect(scored).toHaveLength(expected);
    expect(scored[0]!.properties).toMatchObject({
      eval_run_id: run.runId,
      model: 'stub/perfect-model',
      set: 'smoke',
      judge_model: 'stub/judge',
    });
    const last = sink.events.at(-1)!;
    expect(last.event).toBe('eval_run_completed');
    expect(last.properties).toMatchObject({
      eval_run_id: run.runId,
      pass: true,
      cases: smokeCount(),
      errors: 0,
      pending: 0,
      git_sha: 'abc1234',
      results_file: basename(run.resultsFile),
      tool_selection_pass: true,
    });
  });

  it('sends the eval headers with the run id on every request', async () => {
    await start(perfectScript(cases, oracle));
    const run = await runEval(opts({ model: 'google/gemma-4-31b-it:free' }));
    expect(stub!.calls.length).toBeGreaterThan(0);
    for (const call of stub!.calls) {
      expect(call.headers['x-taphoa-eval-run']).toBe(run.runId);
      expect(call.headers['x-taphoa-today']).toBe('2026-10-20');
      expect(call.headers['x-taphoa-eval-model']).toBe(
        'google/gemma-4-31b-it:free',
      );
    }
    expect(run.model).toBe('google/gemma-4-31b-it:free');
  });

  it('skips pending cases in a full run and lists them', async () => {
    await start(perfectScript(cases, oracle));
    const run = await runEval(opts({ set: 'full' }));
    expect(run.pending.map((p) => p.id)).toEqual(['U13-01', 'U23-01']);
    expect(run.results.map((r) => r.case.id)).not.toContain('U13-01');
    expect(
      stub!.calls.filter((c) => c.path.startsWith('/v1/assistant/digest')),
    ).toHaveLength(0);
    expect(messageCalls(stub!).map(contentOf)).not.toContain(
      'Ai đang nợ tiền quá hạn?',
    );
    const md = readFileSync(run.resultsFile, 'utf8');
    expect(md).toContain('U13-01');
    expect(md).toContain('U23-01');
    expect(basename(run.resultsFile)).toBe('2026-10-25-stub-perfect-model.md');
  });

  it('gives the same result with concurrency 3', async () => {
    await start(perfectScript(cases, oracle));
    const serial = await runEval(opts());
    const parallel = await runEval(opts({ concurrency: 3 }));
    expect(parallel.pass).toBe(true);
    expect(parallel.results.map((r) => r.case.id)).toEqual(
      serial.results.map((r) => r.case.id),
    );
    expect(
      parallel.results.map((r) =>
        r.scores
          .map((s) => `${s.scorer}=${s.value}`)
          .filter((s) => !s.startsWith('latency')),
      ),
    ).toEqual(
      serial.results.map((r) =>
        r.scores
          .map((s) => `${s.scorer}=${s.value}`)
          .filter((s) => !s.startsWith('latency')),
      ),
    );
  });

  it('runs a case that carries a digest through the digest endpoint', async () => {
    const digestCase: GoldenCase = {
      ...cases.find((c) => c.id === 'U13-01')!,
      pending: undefined,
      tags: ['smoke'],
    };
    await start(perfectScript([digestCase], oracle));
    const run = await runEval(opts({ cases: [digestCase] }));
    expect(run.pass).toBe(true);
    expect(
      stub!.calls.filter((c) => c.path === '/v1/assistant/digest'),
    ).toHaveLength(1);
  });
});

function smokeCount() {
  return cases.filter((c) => c.tags.includes('smoke')).length;
}

describe('runEval with the bad stub', () => {
  it('fails the bars and names the failing cases', async () => {
    await start(badScript(cases, oracle));
    const sink = new MemorySink();
    const run = await runEval(opts({ judge: fakeJudge(1), sink }));

    expect(run.pass).toBe(false);
    const failing = new Map(
      run.aggregate.failing.map((f) => [f.case_id, f.scorers]),
    );
    expect(failing.get('U1-01')).toEqual(
      expect.arrayContaining(['tool_selection', 'facts', 'judge']),
    );
    expect(failing.get('U11-01')).toEqual(expect.arrayContaining(['action']));
    expect(failing.get('U3-03')).toEqual(
      expect.arrayContaining(['permission_leak']),
    );
    expect(failing.get('U16-03')).toEqual(
      expect.arrayContaining(['injection_resisted']),
    );
    expect(failing.get('OT-01')).toEqual(
      expect.arrayContaining(['tool_selection']),
    );
    const row = (m: string) => run.aggregate.rows.find((r) => r.metric === m)!;
    expect(row('permission_leak').pass).toBe(false);
    expect(row('injection_resisted').pass).toBe(false);
    expect(readFileSync(run.resultsFile, 'utf8')).toContain('U3-03');
    expect(sink.events.at(-1)!.properties.pass).toBe(false);
  });
});

describe('quota errors from the assistant', () => {
  it('abort the remaining cases and report it', async () => {
    await start(
      perfectWith((req) =>
        req.content === 'Hôm qua bán được bao nhiêu tiền?'
          ? { error: { code: 'quota', message_vi: 'Hết lượt dùng hôm nay.' } }
          : undefined,
      ),
    );
    const sink = new MemorySink();
    const run = await runEval(opts({ sink }));

    expect(run.pass).toBe(false);
    expect(run.aborted).toMatchObject({ code: 'quota', case_id: 'U2-01' });
    expect(run.results.map((r) => r.case.id)).toEqual(['U1-01', 'U2-01']);
    expect(run.notRun).toEqual([
      'U4-02',
      'U3-03',
      'U11-01',
      'U16-02',
      'U16-03',
      'OT-01',
    ]);
    // none of the later cases reached the assistant
    const sent = messageCalls(stub!).map(contentOf);
    expect(sent).toEqual([
      'Tuần tới cần nhập thêm gì?',
      'Hôm qua bán được bao nhiêu tiền?',
    ]);
    // the quota error is not retried
    expect(
      sent.filter((c) => c === 'Hôm qua bán được bao nhiêu tiền?'),
    ).toHaveLength(1);

    const md = readFileSync(run.resultsFile, 'utf8');
    expect(md).toContain('ABORTED');
    expect(md).toContain('U4-02, U3-03');
    expect(sink.events.at(-1)!.event).toBe('eval_run_completed');
    expect(sink.events.at(-1)!.properties.pass).toBe(false);
  });
});

describe('model_unavailable', () => {
  const busy = {
    error: {
      code: 'model_unavailable' as const,
      message_vi: 'Mô hình đang bận.',
    },
  };

  it('is retried once after the retry delay', async () => {
    let first = true;
    await start(
      perfectWith((req) => {
        if (req.content === 'Tuần tới cần nhập thêm gì?' && first) {
          first = false;
          return busy;
        }
        return undefined;
      }),
    );
    const sleep = vi.fn(async () => {});
    const run = await runEval(opts({ retryDelayMs: 25, sleep }));

    expect(run.pass).toBe(true);
    expect(run.aggregate.errors).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(
      messageCalls(stub!).filter(
        (c) => contentOf(c) === 'Tuần tới cần nhập thêm gì?',
      ),
    ).toHaveLength(2);
  });

  it('is reported as an error after the one retry, and the run goes on', async () => {
    await start(
      perfectWith((req) =>
        req.content === 'Tuần tới cần nhập thêm gì?' ? busy : undefined,
      ),
    );
    const run = await runEval(opts());

    expect(
      messageCalls(stub!).filter(
        (c) => contentOf(c) === 'Tuần tới cần nhập thêm gì?',
      ),
    ).toHaveLength(2);
    expect(run.aggregate.errors).toEqual([
      'U1-01: model_unavailable: Mô hình đang bận.',
    ]);
    expect(run.aborted).toBeNull();
    expect(run.results).toHaveLength(smokeCount());
    expect(run.pass).toBe(false); // the failed case scores 0 on tool_selection etc.
    const md = readFileSync(run.resultsFile, 'utf8');
    expect(md).toContain('## Errors');
  });

  it('does not retry other errors', async () => {
    await start(
      perfectWith((req) =>
        req.content === 'Tuần tới cần nhập thêm gì?'
          ? { error: { code: 'internal', message_vi: 'Lỗi.' } }
          : undefined,
      ),
    );
    const run = await runEval(opts());
    expect(
      messageCalls(stub!).filter(
        (c) => contentOf(c) === 'Tuần tới cần nhập thêm gì?',
      ),
    ).toHaveLength(1);
    expect(run.aggregate.errors[0]).toContain('internal');
  });
});

describe('one full run per day', () => {
  it('refuses a second full run on the same day', async () => {
    await start(perfectScript(cases, oracle));
    await runEval(opts({ set: 'full' }));
    const before = stub!.calls.length;

    const err = await runEval(opts({ set: 'full' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FullRunExistsError);
    expect((err as Error).message).toContain('--force');
    expect(stub!.calls.length).toBe(before);
  });

  it('allows it again with force', async () => {
    await start(perfectScript(cases, oracle));
    await runEval(opts({ set: 'full' }));
    const run = await runEval(opts({ set: 'full', force: true }));
    expect(run.pass).toBe(true);
  });

  it('is not blocked by a smoke run, and does not block one', async () => {
    await start(perfectScript(cases, oracle));
    await runEval(opts({ set: 'smoke' }));
    await runEval(opts({ set: 'full' }));
    await runEval(opts({ set: 'smoke' }));
  });

  it('is not blocked by a full run of another day', async () => {
    await start(perfectScript(cases, oracle));
    writeFileSync(join(dir, '2026-10-24-other-model.md'), '# old\n');
    const run = await runEval(opts({ set: 'full' }));
    expect(existsSync(run.resultsFile)).toBe(true);
  });
});

describe('case selection', () => {
  it('filters by id and writes a partial results file', async () => {
    await start(perfectScript(cases, oracle));
    const sink = new MemorySink();
    const run = await runEval(opts({ ids: ['U1-01', 'OT-01'], sink }));
    expect(run.set).toBe('partial');
    expect(run.results.map((r) => r.case.id)).toEqual(['U1-01', 'OT-01']);
    expect(basename(run.resultsFile)).toBe(
      '2026-10-25-stub-perfect-model-partial.md',
    );
    expect(sink.events.at(-1)!.properties.set).toBe('partial');
  });

  it('does not let a partial full run block the real one', async () => {
    await start(perfectScript(cases, oracle));
    await runEval(opts({ set: 'full', ids: ['U1-01'] }));
    await runEval(opts({ set: 'full' }));
  });

  it('filters by tag', async () => {
    await start(perfectScript(cases, oracle));
    const run = await runEval(opts({ tags: ['permission'] }));
    expect(run.results.map((r) => r.case.id)).toEqual(['U3-03']);
  });

  it('rejects an unknown id', async () => {
    await start(perfectScript(cases, oracle));
    await expect(runEval(opts({ ids: ['U1-01', 'U99-01'] }))).rejects.toThrow(
      'U99-01',
    );
    expect(stub!.calls).toHaveLength(0);
  });

  it('rejects an empty selection', async () => {
    await start(perfectScript(cases, oracle));
    await expect(runEval(opts({ tags: ['voice'] }))).rejects.toThrow(
      'no cases',
    );
  });

  it('fails fast on invalid case files', async () => {
    await start(perfectScript(cases, oracle));
    writeFileSync(join(dir, 'U1.jsonl'), '{not json\n');
    const err = await runEval(opts({ cases: undefined, goldenDir: dir })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CaseLoadError);
    expect((err as Error).message).toContain('U1.jsonl:1: invalid JSON');
    expect(stub!.calls).toHaveLength(0);
  });
});

describe('before any request', () => {
  it('checks the free quota first and refuses when it is low', async () => {
    await start(perfectScript(cases, oracle));
    const fetchFn = vi.fn<typeof fetch>(async () => keyResponse(100));
    const err = await runEval(
      opts({ quota: { apiKey: 'sk-secret', fetch: fetchFn } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaError);
    // 9 user messages * 3 + 8 judged cases = 35; needs 135
    expect((err as QuotaError).estimate).toBe(35);
    expect(stub!.calls).toHaveLength(0);
  });

  it('counts no judge requests with the judge off', async () => {
    await start(perfectScript(cases, oracle));
    const err = await runEval(
      opts({
        judge: null,
        quota: { apiKey: 'k', fetch: async () => keyResponse(100) },
      }),
    ).catch((e: unknown) => e);
    expect((err as QuotaError).estimate).toBe(27);
  });

  it('records the quota before and after in the results', async () => {
    await start(perfectScript(cases, oracle));
    let n = 0;
    const fetchFn = vi.fn<typeof fetch>(async () =>
      keyResponse(n++ === 0 ? 900 : 860),
    );
    const run = await runEval(opts({ quota: { apiKey: 'k', fetch: fetchFn } }));
    expect(run.quotaBefore).toEqual({ used: 100, limit: 1000, remaining: 900 });
    expect(run.quotaAfter).toEqual({ used: 140, limit: 1000, remaining: 860 });
    expect(readFileSync(run.resultsFile, 'utf8')).toContain('860 remaining');
  });

  it('can skip the threshold but still record the counters', async () => {
    await start(perfectScript(cases, oracle));
    const run = await runEval(
      opts({
        quota: {
          apiKey: 'k',
          fetch: async () => keyResponse(5),
          skipCheck: true,
        },
      }),
    );
    expect(run.quotaBefore?.remaining).toBe(5);
  });

  it('survives a failing quota read after the run', async () => {
    await start(perfectScript(cases, oracle));
    let n = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      if (n++ === 0) return keyResponse(900);
      throw new TypeError('offline');
    });
    const run = await runEval(opts({ quota: { apiKey: 'k', fetch: fetchFn } }));
    expect(run.quotaAfter).toBeNull();
    expect(run.pass).toBe(true);
  });

  it('fails when a role has no token, before sending anything', async () => {
    await start(perfectScript(cases, oracle));
    const err = await runEval(
      opts({ auth: new EnvAuth({ EVAL_LEAD_TOKEN: 'lead' }) }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('EVAL_SELLER_TOKEN');
    expect(stub!.calls).toHaveLength(0);
  });

  it('fails when an oracle cannot be resolved, naming the case', async () => {
    await start(perfectScript(cases, oracle));
    const broken: OracleProvider = {
      value: async () => {
        throw new Error('relation "sales" does not exist');
      },
      resolveRef: (ref) => oracle.resolveRef(ref),
    };
    const err = await runEval(opts({ oracle: broken })).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain('U1-01');
    expect((err as Error).message).toContain('relation "sales" does not exist');
    expect(stub!.calls).toHaveLength(0);
  });
});

describe('judging', () => {
  it('excludes the model under test and skips failed turns', async () => {
    await start(
      perfectWith((req) =>
        req.content === 'Tuần tới cần nhập thêm gì?'
          ? { error: { code: 'internal', message_vi: 'Lỗi.' } }
          : undefined,
      ),
    );
    const judge = vi.fn<JudgeFn>(async () => ({
      score: 5,
      reason: 'ok',
      model: 'judge/x',
    }));
    const run = await runEval(opts({ judge }));
    expect(judge).toHaveBeenCalledTimes(smokeCount() - 1);
    for (const call of judge.mock.calls) {
      expect(call[1]).toBe('stub/perfect-model');
    }
    // the failed case counts as a judge failure
    const failed = run.results.find((r) => r.case.id === 'U1-01')!;
    expect(failed.scores.find((s) => s.scorer === 'judge')?.value).toBe(0);
    expect(run.judgeModels).toEqual(['judge/x']);
  });

  it('sends only the rubric and the answer to the judge', async () => {
    await start(perfectScript(cases, oracle));
    const judge = vi.fn<JudgeFn>(async () => ({
      score: 5,
      reason: 'ok',
      model: 'judge/x',
    }));
    await runEval(opts({ judge, ids: ['U1-01'] }));
    const input = judge.mock.calls[0]![0];
    expect(Object.keys(input).sort()).toEqual(['answer', 'rubric_vi']);
    expect(input.rubric_vi).toBe(
      cases.find((c) => c.id === 'U1-01')!.rubric_vi,
    );
  });

  it('runs without a judge', async () => {
    await start(perfectScript(cases, oracle));
    const sink = new MemorySink();
    const run = await runEval(opts({ judge: null, sink }));
    const row = run.aggregate.rows.find((r) => r.metric === 'judge')!;
    expect(row.value).toBeNull();
    expect(run.judgeModels).toEqual([]);
    expect(sink.events.at(-1)!.properties.judge_model).toBeNull();
    expect(run.pass).toBe(true);
  });

  it('leaves a case unjudged when the judge fails, and says so', async () => {
    await start(perfectScript(cases, oracle));
    let n = 0;
    const judge: JudgeFn = async () => {
      n++;
      if (n === 1) throw new Error('judge http 429');
      if (n === 2) return null;
      return { score: 5, reason: 'ok', model: 'judge/x' };
    };
    const run = await runEval(opts({ judge }));
    expect(run.unjudged).toEqual(['U1-01', 'U2-01']);
    expect(readFileSync(run.resultsFile, 'utf8')).toContain('U1-01, U2-01');
    expect(run.pass).toBe(true);
  });
});

describe('PostHog failures', () => {
  it('never fail the run', async () => {
    await start(perfectScript(cases, oracle));
    const sink: EventSink = {
      capture: () => {
        throw new Error('capture broke');
      },
      flush: async () => {
        throw new Error('flush broke');
      },
    };
    const warnings: string[] = [];
    const run = await runEval(opts({ sink, log: (l) => warnings.push(l) }));
    expect(run.pass).toBe(true);
    expect(existsSync(run.resultsFile)).toBe(true);
    expect(warnings.join('\n')).toContain('PostHog');
  });
});

describe('script-side request visibility', () => {
  it('lets the script see the run id and role', async () => {
    const seen: StubRequest[] = [];
    await start(
      perfectWith((req) => {
        seen.push(req);
        return undefined;
      }),
    );
    const run = await runEval(opts({ ids: ['U3-03'] }));
    expect(seen[0]!.role).toBe('seller');
    expect(seen[0]!.eval).toMatchObject({
      run: run.runId,
      today: '2026-10-20',
    });
  });
});

function keyResponse(remaining: number): Response {
  return new Response(
    JSON.stringify({
      data: {
        free_model_daily_requests: {
          used: 1000 - remaining,
          limit: 1000,
          remaining,
        },
      },
    }),
    { status: 200 },
  );
}
