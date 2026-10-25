import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadGolden } from '../cases/load.ts';
import type { JudgeFn } from '../judge/judge.ts';
import {
  memoizeOracle,
  resolveCase,
  type OracleProvider,
} from '../oracle/provider.ts';
import {
  caseScoredProperties,
  runCompletedProperties,
  type EventSink,
} from '../posthog.ts';
import {
  checkQuota,
  estimateRequests,
  fetchQuota,
  type Quota,
} from '../quota.ts';
import {
  fullRunExists,
  hcmDate,
  renderResults,
  resultsPath,
  type PendingInfo,
  type RunReport,
  type RunSet,
} from '../results.ts';
import type { Aggregate, CaseResult } from '../scorers/aggregate.ts';
import { aggregate, scoreCase } from '../scorers/index.ts';
import type { GoldenCase, ResolvedCase } from '../types.ts';
import type { AuthProvider } from './auth.ts';
import {
  assertEvalHeaders,
  DEFAULT_TODAY,
  runTurns,
  type TurnOptions,
} from './client.ts';

export const DEFAULT_RETRY_DELAY_MS = 30_000;

/** The golden files have errors; nothing runs until they are fixed. */
export class CaseLoadError extends Error {
  constructor(problems: string[]) {
    super(`invalid golden cases:\n${problems.join('\n')}`);
    this.name = 'CaseLoadError';
  }
}

/** A full run for this day already left a results file. */
export class FullRunExistsError extends Error {
  constructor(date: string, dir: string) {
    super(
      `a full run for ${date} already exists in ${dir}; pass --force to run again`,
    );
    this.name = 'FullRunExistsError';
  }
}

export type RunEvalOptions = {
  /** `smoke` runs the cases tagged smoke; `full` runs all of them. */
  set: 'smoke' | 'full';
  /** Cases to choose from. Without it they are loaded from `goldenDir`. */
  cases?: GoldenCase[];
  goldenDir?: string;
  /** Narrow the set to these ids; the run then counts as `partial`. */
  ids?: string[];
  /** Narrow the set to cases with any of these tags; the run then counts as `partial`. */
  tags?: string[];
  baseUrl: string;
  auth: AuthProvider;
  oracle: OracleProvider;
  /** Scores answers; `null` runs without the judge. */
  judge: JudgeFn | null;
  sink: EventSink;
  /** Where the results file goes. */
  outDir: string;
  /** The OpenRouter free quota guard; `null` skips it (stub runs). */
  quota: { apiKey: string; fetch?: typeof fetch; skipCheck?: boolean } | null;
  /** Sent as `X-Taphoa-Eval-Model` (the model under test). */
  model?: string;
  /** Business date for the run. Default 2026-10-20. */
  today?: string;
  /** Cases in flight at once. Default 1. */
  concurrency?: number;
  /** Wait before the one retry after `model_unavailable`. Default 30 s. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Run a full set again on a day that already has one. */
  force?: boolean;
  now?: () => Date;
  gitSha?: string;
  runId?: string;
  fetch?: typeof fetch;
  turnTimeoutMs?: number;
  log?: (line: string) => void;
};

export type RunSummary = {
  runId: string;
  set: RunSet;
  model: string;
  aggregate: Aggregate;
  results: CaseResult[];
  resultsFile: string;
  /** Every bar met and the run was not aborted. */
  pass: boolean;
  aborted: RunReport['aborted'];
  pending: PendingInfo[];
  notRun: string[];
  unjudged: string[];
  judgeModels: string[];
  quotaBefore: Quota | null;
  quotaAfter: Quota | null;
  report: RunReport;
};

/** Load `<dir>/*.jsonl`, or throw `CaseLoadError` with every problem. */
export function loadCasesOrThrow(dir: string): GoldenCase[] {
  const { cases, errors } = loadGolden(dir);
  if (errors.length > 0) throw new CaseLoadError(errors);
  return cases;
}

/** `eval-20261025T1015-ab12`: the UTC minute plus 4 random hex characters. */
export function makeRunId(
  now: Date,
  random: () => string = () => randomBytes(2).toString('hex'),
): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '');
  return `eval-${stamp}-${random()}`;
}

function selectCases(all: GoldenCase[], opts: RunEvalOptions) {
  let chosen =
    opts.set === 'smoke' ? all.filter((c) => c.tags.includes('smoke')) : all;
  if (opts.ids && opts.ids.length > 0) {
    const missing = opts.ids.filter((id) => !chosen.some((c) => c.id === id));
    if (missing.length > 0) {
      throw new Error(
        `unknown case id(s) in the ${opts.set} set: ${missing.join(', ')}`,
      );
    }
    chosen = chosen.filter((c) => opts.ids!.includes(c.id));
  }
  if (opts.tags && opts.tags.length > 0) {
    chosen = chosen.filter((c) => c.tags.some((t) => opts.tags!.includes(t)));
  }
  const live = chosen.filter((c) => c.pending === undefined);
  const pending: PendingInfo[] = chosen
    .filter((c) => c.pending !== undefined)
    .map((c) => ({ id: c.id, on: c.pending!.on, reason: c.pending!.reason }));
  if (live.length === 0) {
    throw new Error(
      `no cases selected (${chosen.length} matched, ${pending.length} pending)`,
    );
  }
  const partial = (opts.ids?.length ?? 0) > 0 || (opts.tags?.length ?? 0) > 0;
  return { live, pending, set: (partial ? 'partial' : opts.set) as RunSet };
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [value, n] of counts) {
    if (best === null || n > counts.get(best)!) best = value;
  }
  return best;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One eval run: pick the cases, check the free quota, play each case against
 * the backend, resolve the oracle values, judge, score, send the PostHog
 * events and write the results file.
 */
export async function runEval(opts: RunEvalOptions): Promise<RunSummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const date = hcmDate(startedAt);
  const today = opts.today ?? DEFAULT_TODAY;
  const sleep = opts.sleep ?? defaultSleep;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  const all =
    opts.cases ??
    (opts.goldenDir
      ? loadCasesOrThrow(opts.goldenDir)
      : (() => {
          throw new Error('runEval needs cases or goldenDir');
        })());
  const { live, pending, set } = selectCases(all, opts);

  if (set === 'full' && !opts.force && fullRunExists(opts.outDir, date)) {
    throw new FullRunExistsError(date, opts.outDir);
  }
  const runId = opts.runId ?? makeRunId(startedAt);
  assertEvalHeaders(runId, today);

  // Everything that can fail without costing a request comes first.
  for (const role of new Set(live.map((c) => c.role))) {
    await opts.auth.headersFor(role);
  }
  const oracle = memoizeOracle(opts.oracle);
  const resolved = new Map<string, ResolvedCase>();
  for (const c of live) {
    try {
      resolved.set(c.id, await resolveCase(c, oracle));
      if (c.context?.receipt) await oracle.resolveRef(c.context.receipt);
    } catch (e) {
      throw new Error(`oracle failed for ${c.id}: ${(e as Error).message}`);
    }
  }

  let quotaBefore: Quota | null = null;
  if (opts.quota) {
    const { apiKey, fetch: quotaFetch, skipCheck } = opts.quota;
    quotaBefore = skipCheck
      ? await fetchQuota({ apiKey, fetch: quotaFetch })
      : await checkQuota({
          apiKey,
          fetch: quotaFetch,
          estimate: estimateRequests(live, opts.judge !== null),
        });
  }

  log(
    `run ${runId}: ${live.length} cases (${set}), ${pending.length} pending, concurrency ${concurrency}`,
  );

  const turnOpts: TurnOptions = {
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    oracle,
    runId,
    today,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.turnTimeoutMs ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
  };

  const results: (CaseResult | undefined)[] = new Array(live.length);
  const unjudgedAt: boolean[] = [];
  const judgeModels: string[] = [];
  const state: { aborted: RunReport['aborted'] } = { aborted: null };
  let next = 0;
  let finished = 0;

  async function runCase(index: number) {
    const c = live[index]!;
    let turn = await runTurns(turnOpts, c);
    if (turn.error?.code === 'model_unavailable') {
      log(`${c.id}: model_unavailable, retrying in ${retryDelayMs / 1000} s`);
      await sleep(retryDelayMs);
      turn = await runTurns(turnOpts, c);
    }
    if (turn.error?.code === 'quota') {
      state.aborted ??= {
        code: 'quota',
        message: turn.error.message,
        case_id: c.id,
      };
    }

    let judgeScore: number | null = null;
    if (opts.judge) {
      if (turn.error) {
        judgeScore = 0; // a case that never answered cannot pass the judge
      } else {
        try {
          const verdict = await opts.judge(
            { rubric_vi: c.rubric_vi, answer: turn.answer },
            turn.model,
          );
          if (verdict) {
            judgeScore = verdict.score;
            if (!judgeModels.includes(verdict.model))
              judgeModels.push(verdict.model);
          } else {
            unjudgedAt[index] = true;
          }
        } catch (e) {
          unjudgedAt[index] = true;
          log(`${c.id}: judge failed: ${(e as Error).message}`);
        }
      }
    }

    const scores = scoreCase(c, turn, resolved.get(c.id)!, judgeScore);
    results[index] = { case: c, turn, scores };
    const verdict = aggregate([results[index]!]);
    const note = turn.error
      ? `error ${turn.error.code}`
      : verdict.failing[0]
        ? `FAIL ${verdict.failing[0].scorers.join(', ')}`
        : 'ok';
    log(
      `[${++finished}/${live.length}] ${c.id} ${note} (${(turn.latency_ms / 1000).toFixed(1)} s)`,
    );
  }

  async function worker() {
    for (;;) {
      if (state.aborted) return;
      const index = next++;
      if (index >= live.length) return;
      await runCase(index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, live.length) }, worker),
  );

  const done = results.filter((r): r is CaseResult => r !== undefined);
  const notRun = live
    .filter((_, i) => results[i] === undefined)
    .map((c) => c.id);
  const unjudged = live.filter((_, i) => unjudgedAt[i]).map((c) => c.id);
  const agg = aggregate(done);
  const aborted = state.aborted;
  const model =
    opts.model ??
    mostCommon(done.flatMap((r) => (r.turn.model ? [r.turn.model] : []))) ??
    'unknown';

  let quotaAfter: Quota | null = null;
  if (opts.quota) {
    try {
      quotaAfter = await fetchQuota({
        apiKey: opts.quota.apiKey,
        fetch: opts.quota.fetch,
      });
    } catch (e) {
      log(`quota read after the run failed: ${(e as Error).message}`);
    }
  }

  const report: RunReport = {
    runId,
    set,
    model,
    judgeModels,
    gitSha: opts.gitSha ?? 'unknown',
    date,
    backendHost: new URL(opts.baseUrl).host,
    quotaBefore,
    quotaAfter,
    aggregate: agg,
    results: done,
    pending,
    notRun,
    aborted,
    unjudged,
  };
  const resultsFile = resultsPath(opts.outDir, date, model, set);
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(resultsFile, renderResults(report));

  await sendEvents(opts.sink, log, {
    runId,
    model,
    set,
    judgeModel: judgeModels.length > 0 ? judgeModels.join(', ') : null,
    done,
    agg,
    pending: pending.length,
    gitSha: report.gitSha,
    resultsFile: basename(resultsFile),
  });

  return {
    runId,
    set,
    model,
    aggregate: agg,
    results: done,
    resultsFile,
    pass: agg.pass && aborted === null,
    aborted,
    pending,
    notRun,
    unjudged,
    judgeModels,
    quotaBefore,
    quotaAfter,
    report,
  };
}

/** Send the run's events; a sink that fails is logged and never fails the run. */
async function sendEvents(
  sink: EventSink,
  log: (line: string) => void,
  run: {
    runId: string;
    model: string;
    set: RunSet;
    judgeModel: string | null;
    done: CaseResult[];
    agg: Aggregate;
    pending: number;
    gitSha: string;
    resultsFile: string;
  },
) {
  const ctx = {
    runId: run.runId,
    model: run.model,
    set: run.set,
    judgeModel: run.judgeModel,
  };
  try {
    for (const r of run.done) {
      for (const score of r.scores) {
        sink.capture(
          'eval_case_scored',
          caseScoredProperties(
            { ...ctx, model: r.turn.model ?? run.model },
            r.case,
            score,
          ),
        );
      }
    }
    sink.capture(
      'eval_run_completed',
      runCompletedProperties({
        ...ctx,
        cases: run.done.length,
        errors: run.agg.errors.length,
        pending: run.pending,
        aggregate: run.agg,
        gitSha: run.gitSha,
        resultsFile: run.resultsFile,
      }),
    );
  } catch (e) {
    log(`PostHog capture failed: ${(e as Error).message}`);
  }
  try {
    if (!(await sink.flush()))
      log('PostHog: some eval events were not delivered');
  } catch (e) {
    log(`PostHog flush failed: ${(e as Error).message}`);
  }
}
