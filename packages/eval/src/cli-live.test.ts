import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type CliDeps } from './cli.ts';
import { FakeOracle } from './oracle/provider.ts';
import { loadFixtureCases } from './runner/fixtures.ts';
import {
  perfectScript,
  startStubAssistant,
  type StubHandle,
} from './runner/stub-assistant.ts';

const cases = loadFixtureCases();
const oracle = new FakeOracle();

const ENV = {
  EVAL_LEAD_TOKEN: 'lead-secret-token',
  EVAL_SELLER_TOKEN: 'seller-secret-token',
  OPENROUTER_EVAL_API_KEY: 'sk-or-secret-key',
  POSTHOG_PROJECT_TOKEN: 'phc_secret_token',
};

let stub: StubHandle;
let golden: string;
let out: string;
let lines: string[];
let warnings: string[];

beforeEach(async () => {
  stub = await startStubAssistant(perfectScript(cases, oracle));
  golden = mkdtempSync(join(tmpdir(), 'golden-live-'));
  out = mkdtempSync(join(tmpdir(), 'out-live-'));
  const byFile = new Map<string, string[]>();
  for (const c of cases) {
    byFile.set(c.use_case, [
      ...(byFile.get(c.use_case) ?? []),
      JSON.stringify(c),
    ]);
  }
  for (const [name, rows] of byFile) {
    writeFileSync(join(golden, `${name}.jsonl`), rows.join('\n') + '\n');
  }
  lines = [];
  warnings = [];
});

afterEach(async () => {
  await stub.close();
  rmSync(golden, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

/** Routes OpenRouter and PostHog to canned replies; the stub assistant is reached for real. */
function router(remaining = 900) {
  const seen: { url: string; body: unknown }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    if (url.startsWith(stub.url)) return fetch(input, init);
    const raw = init?.body ?? (request ? await request.clone().text() : '');
    seen.push({
      url,
      body: typeof raw === 'string' && raw ? JSON.parse(raw) : null,
    });
    if (url === 'https://openrouter.ai/api/v1/key') {
      return Response.json({
        data: {
          free_model_daily_requests: {
            used: 1000 - remaining,
            limit: 1000,
            remaining,
          },
        },
      });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      return Response.json({
        choices: [{ message: { content: '{"score": 5, "reason": "tốt"}' } }],
      });
    }
    if (url === 'https://us.i.posthog.com/batch/') {
      return Response.json({ status: 1 });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  return { fetchFn, seen };
}

function deps(fetchFn: typeof fetch, over: CliDeps = {}): CliDeps {
  return {
    createOracle: async () => oracle,
    fetch: fetchFn,
    log: (l) => lines.push(l),
    warn: (l) => warnings.push(l),
    gitSha: 'abc1234',
    retryDelayMs: 0,
    now: () => new Date('2026-10-25T03:15:00Z'),
    ...over,
  };
}

describe('live smoke through main()', () => {
  it('runs against a backend with the injected oracle, quota guard, judge and PostHog', async () => {
    const { fetchFn, seen } = router();
    const code = await main(
      ['smoke', '--backend', stub.url, '--dir', golden, '--out', out],
      ENV,
      deps(fetchFn),
    );
    expect(code).toBe(0);

    const urls = seen.map((s) => s.url);
    // quota before and after, one judge call per case, one PostHog batch
    expect(urls.filter((u) => u.endsWith('/api/v1/key'))).toHaveLength(2);
    expect(urls.filter((u) => u.endsWith('/chat/completions'))).toHaveLength(8);
    const batch = seen.find((s) => s.url.endsWith('/batch/'))!.body as {
      api_key: string;
      batch: { event: string }[];
    };
    expect(batch.api_key).toBe('phc_secret_token');
    expect(batch.batch.at(-1)!.event).toBe('eval_run_completed');

    // the judge is a free model other than the one under test
    const judgeBody = seen.find((s) => s.url.endsWith('/chat/completions'))!
      .body as { model: string };
    expect(judgeBody.model).toBe('nvidia/nemotron-3.5-lightning:free');

    // the assistant was reached with bearer tokens from the environment
    const first = stub.calls[0]!;
    expect(first.headers['authorization']).toBe('Bearer lead-secret-token');

    // no secret reaches the output
    const text = lines.join('\n') + warnings.join('\n');
    for (const secret of Object.values(ENV)) expect(text).not.toContain(secret);
    expect(
      readFileSync(join(out, '2026-10-25-stub-perfect-model-smoke.md'), 'utf8'),
    ).toContain('900 remaining');
  });

  it('skips PostHog with --no-posthog and the judge with --no-judge', async () => {
    const { fetchFn, seen } = router();
    const code = await main(
      [
        'smoke',
        '--backend',
        stub.url,
        '--dir',
        golden,
        '--out',
        out,
        '--no-posthog',
        '--no-judge',
      ],
      ENV,
      deps(fetchFn),
    );
    expect(code).toBe(0);
    expect(seen.some((s) => s.url.endsWith('/batch/'))).toBe(false);
    expect(seen.some((s) => s.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('warns and still runs when POSTHOG_PROJECT_TOKEN is missing', async () => {
    const { fetchFn, seen } = router();
    const { POSTHOG_PROJECT_TOKEN: _drop, ...env } = ENV;
    const code = await main(
      ['smoke', '--backend', stub.url, '--dir', golden, '--out', out],
      env,
      deps(fetchFn),
    );
    expect(code).toBe(0);
    expect(warnings.join('\n')).toContain('POSTHOG_PROJECT_TOKEN');
    expect(seen.some((s) => s.url.endsWith('/batch/'))).toBe(false);
  });

  it('refuses to start when the free quota is low, before any request to the assistant', async () => {
    const { fetchFn } = router(100);
    const code = await main(
      ['smoke', '--backend', stub.url, '--dir', golden, '--out', out],
      ENV,
      deps(fetchFn),
    );
    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  it('sends a PostHog batch to POSTHOG_HOST when it is set', async () => {
    const { fetchFn, seen } = router();
    await main(
      ['smoke', '--backend', stub.url, '--dir', golden, '--out', out],
      { ...ENV, POSTHOG_HOST: 'https://eu.i.posthog.com' },
      deps(fetchFn),
    ).catch(() => {});
    // the router only knows the US host, so the EU batch fails and is only warned about
    expect(seen.some((s) => s.url === 'https://eu.i.posthog.com/batch/')).toBe(
      true,
    );
    expect(warnings.join('\n')).toContain('PostHog');
  });

  it('exits 2 when a role has no token', async () => {
    const { fetchFn } = router();
    const { EVAL_SELLER_TOKEN: _drop, ...env } = ENV;
    const code = await main(
      ['smoke', '--backend', stub.url, '--dir', golden, '--out', out],
      env,
      deps(fetchFn),
    );
    expect(code).toBe(2);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('live compare through main()', () => {
  it('checks the quota once for all candidates', async () => {
    // 3 models x 35 requests + 100 = 205 needed
    const { fetchFn } = router(204);
    const code = await main(
      [
        'compare',
        '--models',
        'a/one:free,b/two:free,c/three:free',
        '--backend',
        stub.url,
        '--dir',
        golden,
        '--out',
        out,
      ],
      ENV,
      deps(fetchFn),
    );
    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  it('ranks the models and sends X-Taphoa-Eval-Model for each', async () => {
    const { fetchFn } = router(900);
    const code = await main(
      [
        'compare',
        '--models',
        'a/one:free,b/two:free',
        '--backend',
        stub.url,
        '--dir',
        golden,
        '--out',
        out,
        '--no-posthog',
      ],
      ENV,
      deps(fetchFn),
    );
    expect(code).toBe(0);
    const models = new Set(
      stub.calls.map((c) => c.headers['x-taphoa-eval-model']).filter(Boolean),
    );
    expect(models).toEqual(new Set(['a/one:free', 'b/two:free']));
    const md = readFileSync(join(out, 'model-choice.md'), 'utf8');
    expect(md).toContain('Winner: a/one:free');
  });
});
