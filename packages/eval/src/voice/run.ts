import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApiClient } from '@taphoa/api-client';
import { chooseAuth } from '../cli.ts';
import {
  DEFAULT_POSTHOG_HOST,
  NoopSink,
  PostHogSink,
  type EventSink,
} from '../posthog.ts';
import type { AuthProvider } from '../runner/auth.ts';
import {
  assertEvalHeaders,
  DEFAULT_TODAY,
  withHeaders,
} from '../runner/client.ts';
import { hcmDate } from '../results.ts';
import {
  GOLDEN_VOICE_DIR,
  loadVoiceCases,
  smokeSubset,
  type LoadedVoiceCase,
} from './cases.ts';
import { costFromResponse, fetchPostHogCosts } from './cost.ts';
import {
  renderVoiceMarkdown,
  voiceResultsName,
  type VoiceRunReport,
} from './report.ts';
import { aggregate, scoreCase } from './score.ts';
import type { VoiceOutcome } from './types.ts';

/** Default `VOICE_DAILY_UTTERANCES_PER_STORE` of the backend. */
export const DEFAULT_DAILY_CAP = 300;
export const DEFAULT_RESERVE = 10;
export const DEFAULT_MAX_CASES = 100;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** The run would not leave the store any voice quota. */
export class VoiceQuotaGuardError extends Error {}

export type VoiceRunOptions = {
  baseUrl: string;
  auth: AuthProvider;
  cases: LoadedVoiceCase[];
  /** `X-Taphoa-Eval-Run`. */
  runId: string;
  today?: string;
  /**
   * Sent as `X-Taphoa-Eval-Model`. TODO(V1): the voice backend has no eval header yet; when V1
   * adds one (like ASSISTANT_ALLOW_EVAL_HEADERS for the assistant) it must read this name. Until
   * then the backend ignores the header and the run uses `VOICE_MODELS`.
   */
  model?: string;
  fetch?: typeof fetch;
  readClip?: (path: string) => Uint8Array;
  maxCases?: number;
  /** The store's daily cap and what is already used today. */
  dailyCap?: number;
  usedToday?: number;
  reserve?: number;
  timeoutMs?: number;
  /** Called after each case. */
  onCase?: (index: number, total: number, id: string, note: string) => void;
};

export type VoiceRunResult = {
  outcomes: VoiceOutcome[];
  notRun: string[];
  aborted: VoiceRunReport['aborted'];
};

const asBlob = (bytes: Uint8Array) =>
  new Blob([bytes as BlobPart], { type: 'audio/mp4' });

/** How many requests the guard allows; throws when none. */
export function allowedRequests(opts: {
  total: number;
  maxCases?: number;
  dailyCap?: number;
  usedToday?: number;
  reserve?: number;
}): number {
  const budget =
    (opts.dailyCap ?? DEFAULT_DAILY_CAP) -
    (opts.reserve ?? DEFAULT_RESERVE) -
    (opts.usedToday ?? 0);
  if (budget <= 0) {
    throw new VoiceQuotaGuardError(
      `voice quota guard: ${opts.usedToday ?? 0} of ${opts.dailyCap ?? DEFAULT_DAILY_CAP} utterances used today, ` +
        `${opts.reserve ?? DEFAULT_RESERVE} kept in reserve; nothing to run`,
    );
  }
  return Math.min(opts.total, opts.maxCases ?? DEFAULT_MAX_CASES, budget);
}

/** Post each clip (mode=sale) in order and collect what came back. */
export async function runVoiceCases(
  opts: VoiceRunOptions,
): Promise<VoiceRunResult> {
  const today = opts.today ?? DEFAULT_TODAY;
  assertEvalHeaders(opts.runId, today);
  const allowed = allowedRequests({ ...opts, total: opts.cases.length });
  const read = opts.readClip ?? ((p: string) => readFileSync(p));
  const api = createApiClient({
    baseUrl: opts.baseUrl,
    fetch: withHeaders(
      opts.fetch ?? ((...args) => globalThis.fetch(...args)),
      async () => ({
        ...(await opts.auth.headersFor('lead')),
        'X-Taphoa-Today': today,
        'X-Taphoa-Eval-Run': opts.runId,
        ...(opts.model ? { 'X-Taphoa-Eval-Model': opts.model } : {}),
      }),
    ),
  });
  const outcomes: VoiceOutcome[] = [];
  let aborted: VoiceRunResult['aborted'] = null;
  const toRun = opts.cases.slice(0, allowed);
  for (const [i, c] of toRun.entries()) {
    const started = Date.now();
    let outcome: VoiceOutcome;
    try {
      const { data, error, response } = await api.createVoiceUtterance({
        audio: asBlob(read(c.audio_path)),
        filename: `${c.id}.m4a`,
        mode: 'sale',
        language: c.language,
        context: { entry: 'chip', screen: 'eval' },
      });
      const wall_ms = Date.now() - started;
      const code = (error as { code?: string } | undefined)?.code;
      outcome = {
        case_id: c.id,
        status: response.status,
        wall_ms,
        ...(data
          ? { utterance: data, cost_usd: costFromResponse(data) }
          : { error_code: code ?? `http_${response.status}` }),
      };
    } catch (e) {
      outcome = {
        case_id: c.id,
        status: 0,
        error_code: `network: ${(e as Error).message}`,
        wall_ms: Date.now() - started,
      };
    }
    outcomes.push(outcome);
    opts.onCase?.(i + 1, toRun.length, c.id, outcome.error_code ?? 'ok');
    // The daily cap and a rejected login end the run; other failures are scored.
    if (
      outcome.error_code === 'voice_quota' ||
      [401, 403].includes(outcome.status)
    ) {
      aborted = {
        code: outcome.error_code ?? `http_${outcome.status}`,
        message:
          outcome.error_code === 'voice_quota'
            ? 'the store hit its daily voice cap'
            : `HTTP ${outcome.status}: check the eval login`,
        case_id: c.id,
      };
      break;
    }
  }
  const ran = new Set(outcomes.map((o) => o.case_id));
  return {
    outcomes,
    notRun: opts.cases.filter((c) => !ran.has(c.id)).map((c) => c.id),
    aborted,
  };
}

export type BuildReportOptions = {
  runId: string;
  date: string;
  model?: string;
  set: VoiceRunReport['set'];
  backendHost: string;
  gitSha: string;
};

/** Score a finished run. The model name is `--model`, else the slug the backend used most. */
export function buildReport(
  cases: LoadedVoiceCase[],
  run: VoiceRunResult,
  o: BuildReportOptions,
): VoiceRunReport {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = run.outcomes.map((outcome) => {
    const c = byId.get(outcome.case_id)!;
    return { case: c, outcome, score: scoreCase(c, outcome) };
  });
  const counts = new Map<string, number>();
  for (const r of results) {
    const m = r.outcome.utterance?.model;
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const reported = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    runId: o.runId,
    date: o.date,
    model: o.model ?? reported ?? 'default',
    set: o.set,
    backendHost: o.backendHost,
    gitSha: o.gitSha,
    aggregate: aggregate(
      results.map((r) => r.score),
      run.outcomes,
    ),
    results,
    notRun: run.notRun,
    aborted: run.aborted,
  };
}

/** `eval_voice_case_scored` per case and `eval_voice_run_completed` once. */
export function sendToPostHog(
  sink: EventSink,
  run: VoiceRunReport,
  file: string,
) {
  for (const { case: c, outcome, score } of run.results) {
    sink.capture('eval_voice_case_scored', {
      eval_run_id: run.runId,
      model: run.model,
      case_id: c.id,
      use_case: 'voice',
      set: run.set,
      tags: c.tags,
      source: c.source,
      intent_ok: score.intent_ok,
      exact: score.exact,
      lines_expected: score.lines_expected,
      lines_ok: score.lines_ok,
      quantity_ok: score.quantity_ok,
      price_ok: score.price_ok,
      extra_lines: score.extra_lines,
      payment_ok: score.payment_ok,
      error: score.error,
      wer_edits: score.wer?.edits ?? null,
      wer_words: score.wer?.words ?? null,
      latency_ms: outcome.wall_ms,
      cost_usd: outcome.cost_usd ?? null,
      utterance_id: outcome.utterance?.id ?? null,
    });
  }
  const a = run.aggregate;
  sink.capture('eval_voice_run_completed', {
    eval_run_id: run.runId,
    model: run.model,
    set: run.set,
    use_case: 'voice',
    pass: a.pass,
    aborted: run.aborted?.code ?? null,
    cases: a.cases,
    errors: a.errors,
    not_run: run.notRun.length,
    git_sha: run.gitSha,
    results_file: file,
    line_accuracy: a.line_accuracy,
    price_accuracy: a.price_accuracy,
    quantity_accuracy: a.quantity_accuracy,
    intent_accuracy: a.intent_accuracy,
    payment_accuracy: a.payment_accuracy,
    wer: a.wer,
    wer_nodiac: a.wer_nodiac,
    latency_p50_ms: a.latency_p50_ms,
    latency_p95_ms: a.latency_p95_ms,
    cost_per_utterance_usd: a.cost_per_utterance_usd,
  });
}

/** Write `voice-<date>-<model>[-smoke].json` and `.md`; returns the two paths. */
export function writeResults(dir: string, run: VoiceRunReport) {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(
    dir,
    voiceResultsName(run.date, run.model, run.set, 'json'),
  );
  const mdPath = join(
    dir,
    voiceResultsName(run.date, run.model, run.set, 'md'),
  );
  const slim = {
    ...run,
    results: run.results.map(({ case: c, outcome, score }) => ({
      case_id: c.id,
      intent: c.intent,
      tags: c.tags,
      source: c.source,
      score,
      outcome: {
        status: outcome.status,
        error_code: outcome.error_code,
        wall_ms: outcome.wall_ms,
        cost_usd: outcome.cost_usd ?? null,
        transcript: outcome.utterance?.transcript,
        intent: outcome.utterance?.intent,
        model: outcome.utterance?.model,
        stt_fallback: outcome.utterance?.stt_fallback,
        latency_ms: outcome.utterance?.latency_ms,
        utterance_id: outcome.utterance?.id,
        sale_draft: outcome.utterance?.sale_draft,
      },
    })),
  };
  writeFileSync(jsonPath, `${JSON.stringify(slim, null, 2)}\n`);
  writeFileSync(mdPath, renderVoiceMarkdown(run));
  return { jsonPath, mdPath };
}

class UsageError extends Error {}

const USAGE = `usage: node src/voice/run.ts [options]

  --subset smoke|full   smoke = the 10 clips tagged smoke (default full)
  --ids a,b             only these clip ids (run is then "partial")
  --backend URL         backend to test (or BACKEND_URL)
  --model ID            X-Taphoa-Eval-Model (needs a backend that honours it)
  --max-cases N         stop after N clips (default ${DEFAULT_MAX_CASES})
  --daily-cap N         store's daily voice cap (or VOICE_DAILY_UTTERANCES_PER_STORE, default ${DEFAULT_DAILY_CAP})
  --used-today N        utterances the store already used today (default 0)
  --reserve N           keep N utterances free below the cap (default ${DEFAULT_RESERVE})
  --dir DIR             clips and sidecars (default golden/voice)
  --out DIR             results directory (default results)
  --posthog | --no-posthog   send eval_voice_* events (default: when POSTHOG_PROJECT_TOKEN is set)
  --posthog-cost        read cost per utterance from PostHog $ai_generation afterwards
                        (POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_API_HOST)

Environment: BACKEND_URL, EVAL_LEAD_TOKEN or CLERK_SECRET_KEY, EVAL_STORE_ID, EVAL_TODAY.
Exit codes: 0 bars passed, 1 bars missed or run aborted/refused, 2 bad usage.`;

const BOOLEANS = ['--posthog', '--no-posthog', '--posthog-cost', '--help'];
const VALUES = [
  '--subset',
  '--ids',
  '--backend',
  '--model',
  '--max-cases',
  '--daily-cap',
  '--used-today',
  '--reserve',
  '--dir',
  '--out',
];

function parseArgs(args: string[]) {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    if (BOOLEANS.includes(name) && eq < 0) booleans.add(name);
    else if (VALUES.includes(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : args[++i];
      if (!v) throw new UsageError(`${name} needs a value`);
      values.set(name, v);
    } else throw new UsageError(`unknown option ${a}`);
  }
  return { booleans, values };
}

function whole(values: Map<string, string>, name: string): number | undefined {
  const v = values.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new UsageError(`${name} must be a whole number`);
  return n;
}

function gitSha(env: Record<string, string | undefined>): string {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export type VoiceCliDeps = {
  fetch?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => Date;
  auth?: AuthProvider;
};

export async function main(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  deps: VoiceCliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  try {
    const { booleans, values } = parseArgs(args);
    if (booleans.has('--help')) {
      log(USAGE);
      return 0;
    }
    if (booleans.has('--posthog') && booleans.has('--no-posthog'))
      throw new UsageError('--posthog and --no-posthog contradict each other');
    const subset = values.get('--subset') ?? 'full';
    if (subset !== 'smoke' && subset !== 'full')
      throw new UsageError('--subset must be smoke or full');
    const baseUrl = values.get('--backend') ?? env.BACKEND_URL?.trim() ?? '';
    if (!baseUrl)
      throw new UsageError('BACKEND_URL is not set (or pass --backend URL)');
    try {
      new URL(baseUrl);
    } catch {
      throw new UsageError(`backend URL is not a URL: ${baseUrl}`);
    }
    const dir = values.get('--dir')
      ? resolve(values.get('--dir')!)
      : GOLDEN_VOICE_DIR;
    const outDir = values.get('--out')
      ? resolve(values.get('--out')!)
      : join(import.meta.dirname, '..', '..', 'results');
    let cases = loadVoiceCases(dir);
    const ids = values
      .get('--ids')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids) cases = cases.filter((c) => ids.includes(c.id));
    else if (subset === 'smoke') cases = smokeSubset(cases);
    if (cases.length === 0) throw new UsageError('no clips selected');
    const set: VoiceRunReport['set'] = ids ? 'partial' : subset;

    const today = env.EVAL_TODAY?.trim() || DEFAULT_TODAY;
    const now = deps.now?.() ?? new Date();
    const runId = `voice-${hcmDate(now)}-${randomBytes(3).toString('hex')}`;
    const dailyCap =
      whole(values, '--daily-cap') ??
      (Number(env.VOICE_DAILY_UTTERANCES_PER_STORE) || DEFAULT_DAILY_CAP);

    let sink: EventSink = new NoopSink();
    if (!booleans.has('--no-posthog')) {
      const token = env.POSTHOG_PROJECT_TOKEN?.trim();
      if (token)
        sink = new PostHogSink({
          token,
          host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
          fetch: deps.fetch,
          warn,
        });
      else if (booleans.has('--posthog'))
        throw new UsageError('--posthog needs POSTHOG_PROJECT_TOKEN');
      else
        warn('POSTHOG_PROJECT_TOKEN is not set: eval events will not be sent');
    }

    const run = await runVoiceCases({
      baseUrl,
      auth: deps.auth ?? chooseAuth(env, deps.fetch),
      cases,
      runId,
      today,
      model: values.get('--model'),
      fetch: deps.fetch,
      maxCases: whole(values, '--max-cases'),
      dailyCap,
      usedToday: whole(values, '--used-today'),
      reserve: whole(values, '--reserve'),
      onCase: (i, n, id, note) => log(`[${i}/${n}] ${id} ${note}`),
    });

    if (booleans.has('--posthog-cost')) {
      const key = env.POSTHOG_PERSONAL_API_KEY?.trim();
      const projectId = env.POSTHOG_PROJECT_ID?.trim();
      if (!key || !projectId) {
        warn(
          '--posthog-cost needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID: skipped',
        );
      } else {
        try {
          const costs = await fetchPostHogCosts({
            host:
              env.POSTHOG_API_HOST?.trim() ||
              env.POSTHOG_HOST?.trim() ||
              DEFAULT_POSTHOG_HOST,
            projectId,
            personalApiKey: key,
            utteranceIds: run.outcomes.flatMap((o) =>
              o.utterance ? [o.utterance.id] : [],
            ),
            fetch: deps.fetch,
          });
          for (const o of run.outcomes)
            if (o.utterance && o.cost_usd == null)
              o.cost_usd = costs.get(o.utterance.id.toLowerCase()) ?? null;
        } catch (e) {
          warn(`PostHog cost lookup failed: ${(e as Error).message}`);
        }
      }
    }

    const report = buildReport(cases, run, {
      runId,
      date: hcmDate(now),
      model: values.get('--model'),
      set,
      backendHost: new URL(baseUrl).host,
      gitSha: gitSha(env),
    });
    const { jsonPath, mdPath } = writeResults(outDir, report);
    sendToPostHog(sink, report, jsonPath);
    await sink.flush();
    const a = report.aggregate;
    log(
      `${report.aborted ? 'ABORTED' : a.pass ? 'PASS' : 'FAIL'} ${report.model}: ` +
        `lines ${a.line_accuracy === null ? 'n/a' : (a.line_accuracy * 100).toFixed(1) + ' %'}, ` +
        `price ${a.price_accuracy === null ? 'n/a' : (a.price_accuracy * 100).toFixed(1) + ' %'}, ` +
        `${a.errors} errors, ${report.notRun.length} not run`,
    );
    log(`results: ${mdPath}`);
    return report.aborted || !a.pass ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
