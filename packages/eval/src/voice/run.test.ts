import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceUtterance } from '@taphoa/api-client';
import { describe, expect, it, vi } from 'vitest';
import { MemorySink } from '../posthog.ts';
import type { AuthProvider } from '../runner/auth.ts';
import { loadVoiceCases } from './cases.ts';
import {
  allowedRequests,
  buildReport,
  main,
  runVoiceCases,
  sendToPostHog,
  VoiceQuotaGuardError,
  writeResults,
} from './run.ts';
import type { VoiceCase } from './types.ts';

const cases = loadVoiceCases();
const byId = new Map(cases.map((c) => [c.id, c]));
const auth: AuthProvider = {
  headersFor: async () => ({
    Authorization: 'Bearer test',
    'X-Store-Id': 'store',
  }),
};

/** What a perfect backend answers for a case. */
function perfect(c: VoiceCase, index: number): Response {
  if (c.intent === 'none')
    return Response.json(
      { error: 'nothing heard', code: 'no_speech' },
      { status: 422 },
    );
  const body: VoiceUtterance = {
    id: `0192f2c6-0000-7000-8000-${String(index).padStart(12, '0')}`,
    mode: 'sale',
    transcript: c.transcript,
    language: 'vi',
    intent: c.intent,
    model: 'fake/model',
    latency_ms: 1000 + index,
    created_at: '2026-10-28T00:00:00Z',
    ...(c.intent === 'sale'
      ? {
          sale_draft: {
            payment_method: c.payment_method ?? 'cash',
            total: 0,
            ...(c.customer_name
              ? {
                  customer: { status: 'matched', spoken_name: c.customer_name },
                }
              : {}),
            lines: c.lines.map((l, i) => ({
              id: `0192f2c6-1111-7000-8000-${String(i).padStart(12, '0')}`,
              spoken: l.spoken,
              status: l.status ?? (l.product ? 'matched' : 'unknown'),
              ...(l.product
                ? {
                    product: {
                      id: `0192f2c6-2222-7000-8000-000000000001`,
                      name: l.product,
                      price: 1000,
                      base_unit: 'cái',
                    },
                  }
                : {}),
              quantity: l.quantity,
              unit_price: l.unit_price ?? 1000,
              price_source: l.unit_price === null ? 'catalog' : 'spoken',
            })),
          } as NonNullable<VoiceUtterance['sale_draft']>,
        }
      : {}),
  };
  return Response.json(body, { status: 201 });
}

type Seen = { url: string; headers: Headers; id: string; mode: string };

function fakeBackend(answer: (c: VoiceCase, n: number) => Response = perfect) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn(
    async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const form = await req.formData();
      const file = form.get('audio') as File;
      const id = file.name.replace(/\.m4a$/, '');
      seen.push({
        url: req.url,
        headers: req.headers,
        id,
        mode: String(form.get('mode')),
      });
      expect(file.size).toBeGreaterThan(0);
      return answer(byId.get(id)!, seen.length);
    },
  );
  return { seen, fetch: fetchMock as unknown as typeof fetch };
}

const base = {
  baseUrl: 'https://backend.test',
  auth,
  runId: 'voice-test-1',
  today: '2026-10-20',
};

describe('runVoiceCases', () => {
  it('posts every clip as mode=sale with the eval headers and scores a perfect backend 100 %', async () => {
    const { seen, fetch } = fakeBackend();
    const run = await runVoiceCases({
      ...base,
      cases,
      fetch,
      model: 'google/x',
    });
    expect(seen).toHaveLength(cases.length);
    expect(seen.every((s) => s.mode === 'sale')).toBe(true);
    expect(seen[0]!.url).toBe('https://backend.test/v1/voice/utterances');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer test');
    expect(seen[0]!.headers.get('x-store-id')).toBe('store');
    expect(seen[0]!.headers.get('x-taphoa-eval-run')).toBe('voice-test-1');
    expect(seen[0]!.headers.get('x-taphoa-today')).toBe('2026-10-20');
    expect(seen[0]!.headers.get('x-taphoa-eval-model')).toBe('google/x');

    const report = buildReport(cases, run, {
      runId: 'voice-test-1',
      date: '2026-10-28',
      set: 'full',
      backendHost: 'backend.test',
      gitSha: 'abc',
    });
    expect(report.model).toBe('fake/model');
    expect(report.aggregate).toMatchObject({
      cases: cases.length,
      errors: 0,
      line_accuracy: 1,
      price_accuracy: 1,
      intent_accuracy: 1,
      payment_accuracy: 1,
      customer_accuracy: 1,
      wer: 0,
      pass: true,
    });
    expect(report.aggregate.latency_p95_ms).not.toBeNull();
    expect(report.results.every((r) => r.score.exact)).toBe(true);
  });

  it('omits the model header without --model', async () => {
    const { seen, fetch } = fakeBackend();
    await runVoiceCases({ ...base, cases: cases.slice(0, 1), fetch });
    expect(seen[0]!.headers.has('x-taphoa-eval-model')).toBe(false);
  });

  it('stops at the quota guard and lists the clips it skipped', async () => {
    const { seen, fetch } = fakeBackend();
    const run = await runVoiceCases({
      ...base,
      cases,
      fetch,
      dailyCap: 20,
      usedToday: 5,
      reserve: 10,
    });
    expect(seen).toHaveLength(5);
    expect(run.notRun).toHaveLength(cases.length - 5);
  });

  it('honours --max-cases and refuses a store with no room', async () => {
    const { seen, fetch } = fakeBackend();
    await runVoiceCases({ ...base, cases, fetch, maxCases: 3 });
    expect(seen).toHaveLength(3);
    expect(() =>
      allowedRequests({ total: 5, dailyCap: 100, usedToday: 95, reserve: 10 }),
    ).toThrow(VoiceQuotaGuardError);
    await expect(
      runVoiceCases({ ...base, cases, fetch, dailyCap: 10, reserve: 10 }),
    ).rejects.toThrow('quota guard');
  });

  it('aborts on a 429 voice_quota from the backend', async () => {
    const { seen, fetch } = fakeBackend((c, n) =>
      n === 2
        ? Response.json({ error: 'cap', code: 'voice_quota' }, { status: 429 })
        : perfect(c, n),
    );
    const run = await runVoiceCases({ ...base, cases, fetch });
    expect(seen).toHaveLength(2);
    expect(run.aborted).toMatchObject({ code: 'voice_quota' });
    expect(run.notRun).toHaveLength(cases.length - 2);
  });

  it('scores 5xx and network errors without stopping', async () => {
    const { fetch } = fakeBackend((c, n) => {
      if (n === 1)
        return Response.json(
          { error: 'down', code: 'voice_unavailable' },
          { status: 503 },
        );
      if (n === 2) throw new TypeError('socket hang up');
      return perfect(c, n);
    });
    const run = await runVoiceCases({
      ...base,
      cases: cases.slice(0, 4),
      fetch,
    });
    const report = buildReport(cases, run, {
      runId: 'r',
      date: '2026-10-28',
      set: 'partial',
      backendHost: 'h',
      gitSha: 'x',
    });
    expect(report.aggregate.errors).toBe(2);
    expect(report.results[0]!.score.error).toBe('voice_unavailable');
    expect(report.results[1]!.score.error).toMatch(/network/);
    expect(report.aborted).toBeNull();
  });

  it('reads a cost from the response when it has one', async () => {
    const { fetch } = fakeBackend((c, n) => {
      const res = perfect(c, n);
      return res.status === 201
        ? (res
            .json()
            .then((b) =>
              Response.json({ ...b, cost_usd: 0.0012 }, { status: 201 }),
            ) as unknown as Response)
        : res;
    });
    const run = await runVoiceCases({
      ...base,
      cases: cases.slice(0, 1),
      fetch,
    });
    expect(run.outcomes[0]!.cost_usd).toBe(0.0012);
  });
});

describe('results and PostHog', () => {
  it('writes json and markdown files and sends eval_voice events', async () => {
    const { fetch } = fakeBackend();
    const some = cases.slice(0, 5);
    const run = await runVoiceCases({ ...base, cases: some, fetch });
    const report = buildReport(some, run, {
      runId: 'voice-test-1',
      date: '2026-10-28',
      model: 'google/gemini-2.5-flash-lite',
      set: 'smoke',
      backendHost: 'b',
      gitSha: 'abc',
    });
    const dir = mkdtempSync(join(tmpdir(), 'voice-results-'));
    const { jsonPath, mdPath } = writeResults(dir, report);
    expect(
      jsonPath.endsWith(
        'voice-2026-10-28-google-gemini-2.5-flash-lite-smoke.json',
      ),
    ).toBe(true);
    const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(json.results).toHaveLength(5);
    expect(json.aggregate.line_accuracy).toBe(1);
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toContain('Verdict: **PASS**');
    expect(md).toContain('| 01-single-coca |');
    const sink = new MemorySink();
    sendToPostHog(sink, report, jsonPath);
    expect(
      sink.events.filter((e) => e.event === 'eval_voice_case_scored'),
    ).toHaveLength(5);
    expect(sink.events.at(-1)).toMatchObject({
      event: 'eval_voice_run_completed',
      properties: {
        pass: true,
        model: 'google/gemini-2.5-flash-lite',
        line_accuracy: 1,
      },
    });
  });
});

describe('main (dry run against a fake backend)', () => {
  it('runs the smoke subset, writes results and exits 0', async () => {
    const { seen, fetch } = fakeBackend();
    const out = mkdtempSync(join(tmpdir(), 'voice-main-'));
    const lines: string[] = [];
    const code = await main(
      [
        '--subset',
        'smoke',
        '--backend',
        'https://backend.test',
        '--out',
        out,
        '--no-posthog',
      ],
      { EVAL_TODAY: '2026-10-20' },
      {
        fetch,
        auth,
        log: (l) => lines.push(l),
        now: () => new Date('2026-10-28T03:00:00Z'),
      },
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(10);
    expect(lines.join('\n')).toContain('PASS fake/model');
    expect(
      readFileSync(join(out, 'voice-2026-10-28-fake-model-smoke.md'), 'utf8'),
    ).toContain('PASS');
  });

  it('exits 1 when the bars are missed', async () => {
    const { fetch } = fakeBackend((c, n) =>
      c.intent === 'sale'
        ? perfect(
            {
              ...c,
              lines: c.lines.map((l) => ({ ...l, quantity: l.quantity + 1 })),
            },
            n,
          )
        : perfect(c, n),
    );
    const out = mkdtempSync(join(tmpdir(), 'voice-main-'));
    const code = await main(
      [
        '--subset',
        'smoke',
        '--backend',
        'https://b.test',
        '--out',
        out,
        '--no-posthog',
      ],
      {},
      { fetch, auth, log: () => {} },
    );
    expect(code).toBe(1);
  });

  it('exits 2 without a backend or with a bad flag', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--no-posthog'], {}, { auth })).toBe(2);
    expect(
      await main(['--bogus'], { BACKEND_URL: 'https://b.test' }, { auth }),
    ).toBe(2);
    expect(
      await main(
        ['--subset', 'half', '--backend', 'https://b.test'],
        {},
        { auth },
      ),
    ).toBe(2);
    err.mockRestore();
  });
});
