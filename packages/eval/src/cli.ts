import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { checkCoverage } from './cases/coverage.ts';
import { loadGolden } from './cases/load.ts';
import {
  calibrate,
  loadCalibrationItems,
  renderCalibration,
} from './judge/calibrate.ts';
import {
  fakeJudge,
  judgeModelsFromEnv,
  makeJudge,
  type JudgeFn,
} from './judge/judge.ts';
import { ORACLE_NAMES } from './oracle/catalog.ts';
import {
  createLiveOracle,
  openEvalDatabase,
  OracleUnavailableError,
} from './oracle/live.ts';
import { FakeOracle, type OracleProvider } from './oracle/provider.ts';
import {
  renderOraclesMd,
  renderOraclesText,
  runCatalog,
} from './oracle/report.ts';
import {
  DEFAULT_POSTHOG_HOST,
  MemorySink,
  NoopSink,
  PostHogSink,
  type EventSink,
} from './posthog.ts';
import { checkQuota, estimateRequests } from './quota.ts';
import { hcmDate, renderModelChoice, type ModelChoiceRow } from './results.ts';
import {
  AuthConfigError,
  ClerkAuth,
  DEFAULT_EVAL_STORE_ID,
  EnvAuth,
  StubAuth,
  type AuthProvider,
} from './runner/auth.ts';
import { assertEvalHeaders, DEFAULT_TODAY } from './runner/client.ts';
import { loadFixtureCases } from './runner/fixtures.ts';
import {
  CaseLoadError,
  loadCasesOrThrow,
  runEval,
  type RunEvalOptions,
  type RunSummary,
} from './runner/run.ts';
import {
  badScript,
  perfectScript,
  startStubAssistant,
  type StubHandle,
} from './runner/stub-assistant.ts';
import { formatValue } from './scorers/aggregate.ts';
import type { GoldenCase } from './types.ts';

const USAGE = [
  'usage: node src/cli.ts <command> [options]',
  '  validate [--dir golden]            check the golden cases, their coverage and oracle names',
  '  oracles [--md] [--out file]        run every oracle against EVAL_DATABASE_URL and print',
  '                                     the values; --md writes ORACLES.md instead',
  '  smoke|full [options]               run the smoke set (25 cases) or every case',
  '  compare --models a,b,c [options]   run the smoke set once per model and rank them',
  '  identities [--github-env]          mint a Clerk token for both roles (CLERK_SECRET_KEY) as a',
  '                                     pre-flight check; --github-env also writes masked',
  '                                     EVAL_LEAD_TOKEN, EVAL_SELLER_TOKEN and EVAL_STORE_ID to $GITHUB_ENV',
  '  calibrate [--judge-model id] [--file f] [--out dir]',
  '                                     check the judge against hand-labelled answers',
  '',
  'smoke, full and compare options:',
  '  --stub | --bad-stub    dry run against the in-process stub assistant (perfect | failing)',
  '  --model <id>           send X-Taphoa-Eval-Model (smoke, full)',
  '  --ids a,b  --tags t    narrow the set (smoke, full); the run is then "partial"',
  '  --concurrency n        cases in flight at once (default 1)',
  '  --force                run a second full run today (full)',
  '  --posthog | --no-posthog   send events (a stub run sends none unless --posthog)',
  '  --no-judge             skip the LLM judge',
  '  --backend URL  --dir golden-dir  --out results-dir',
  '',
  'environment: BACKEND_URL EVAL_DATABASE_URL OPENROUTER_EVAL_API_KEY EVAL_JUDGE_MODELS',
  '  POSTHOG_PROJECT_TOKEN POSTHOG_HOST EVAL_TODAY EVAL_STORE_ID EVAL_LEAD_TOKEN EVAL_SELLER_TOKEN',
  '  CLERK_SECRET_KEY CLERK_API_URL (mint tokens during the run when EVAL_LEAD_TOKEN is not set)',
  'exit codes: 0 pass, 1 a bar was missed or the run was refused or aborted, 2 bad usage or configuration',
].join('\n');

const PACKAGE_DIR = resolve(import.meta.dirname, '..');
/** The golden directory next to this package's src, whatever the cwd is. */
const DEFAULT_DIR = join(PACKAGE_DIR, 'golden');
const DEFAULT_OUT = join(PACKAGE_DIR, 'results');
const DEFAULT_ORACLES_MD = join(PACKAGE_DIR, 'ORACLES.md');
const DEFAULT_CALIBRATION = join(
  import.meta.dirname,
  'judge',
  'calibration.jsonl',
);

/** Wrong flags or missing configuration: exit 2. */
class UsageError extends Error {}

export type CliDeps = {
  /** Builds the oracle of live runs (default: the pg provider of `oracle/live.ts`). */
  createOracle?: (
    env: Record<string, string | undefined>,
  ) => Promise<OracleProvider>;
  /** Used for OpenRouter (quota, judge) and PostHog calls. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => Date;
  gitSha?: string;
  retryDelayMs?: number;
};

type Flags = {
  booleans: Set<string>;
  values: Map<string, string>;
};

/** `--flag`, `--key value` and `--key=value`; anything else is a usage error. */
function parseFlags(
  args: string[],
  booleans: readonly string[],
  values: readonly string[],
): Flags {
  const flags: Flags = { booleans: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') ? (eq < 0 ? arg : arg.slice(0, eq)) : '';
    if (booleans.includes(name) && eq < 0) {
      flags.booleans.add(name);
    } else if (values.includes(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '') {
        throw new UsageError(`${name} needs a value`);
      }
      flags.values.set(name, value);
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  return flags;
}

const list = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');

function validate(args: string[], log: (line: string) => void): number {
  let dir = DEFAULT_DIR;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dir' && args[i + 1] !== undefined) {
      dir = resolve(args[++i]!);
    } else if (arg.startsWith('--dir=') && arg.length > '--dir='.length) {
      dir = resolve(arg.slice('--dir='.length));
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  // Show paths relative to where the command ran, so editors can open them.
  const { cases, errors } = loadGolden(relative(process.cwd(), dir) || '.');
  const problems = [...errors, ...checkCoverage(cases, ORACLE_NAMES)];
  if (problems.length === 0) {
    log(`ok: ${cases.length} golden cases`);
    return 0;
  }
  for (const problem of problems) log(problem);
  log(`${problems.length} problem(s) in ${cases.length} valid cases`);
  return 1;
}

const RUN_BOOLEANS = [
  '--stub',
  '--bad-stub',
  '--posthog',
  '--no-posthog',
  '--no-judge',
] as const;
const RUN_VALUES = ['--concurrency', '--backend', '--out', '--dir'] as const;

/** Everything a run command needs, built from flags and the environment. */
type Prepared = {
  cases: GoldenCase[];
  stub: boolean;
  baseUrl: string;
  auth: AuthProvider;
  oracle: OracleProvider;
  judge: JudgeFn | null;
  sink: EventSink;
  quota: RunEvalOptions['quota'];
  outDir: string;
  today: string;
  concurrency: number;
  closeStub: () => Promise<void>;
};

/**
 * Fixed tokens (`EVAL_LEAD_TOKEN`) win; otherwise `CLERK_SECRET_KEY` mints
 * tokens during the run; otherwise `EnvAuth` reports the missing token.
 */
export function chooseAuth(
  env: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
): AuthProvider {
  if (!env.EVAL_LEAD_TOKEN?.trim()) {
    const clerk = ClerkAuth.fromEnv(env, fetchFn);
    if (clerk) return clerk;
  }
  return new EnvAuth(env);
}

async function prepare(
  flags: Flags,
  env: Record<string, string | undefined>,
  deps: Required<Pick<CliDeps, 'log' | 'warn'>> & CliDeps,
): Promise<Prepared> {
  const { booleans, values } = flags;
  const bad = booleans.has('--bad-stub');
  const stub = bad || booleans.has('--stub');
  if (booleans.has('--posthog') && booleans.has('--no-posthog')) {
    throw new UsageError('--posthog and --no-posthog contradict each other');
  }

  const concurrencyText = values.get('--concurrency');
  const concurrency =
    concurrencyText === undefined ? 1 : Number(concurrencyText);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new UsageError('--concurrency must be a whole number of 1 or more');
  }

  const today = env.EVAL_TODAY?.trim() || DEFAULT_TODAY;
  try {
    assertEvalHeaders('check', today);
  } catch {
    throw new UsageError(
      `EVAL_TODAY must look like YYYY-MM-DD, got ${JSON.stringify(today)}`,
    );
  }

  // Live runs need a backend and the OpenRouter key before anything else.
  const baseUrl = values.get('--backend') ?? env.BACKEND_URL?.trim() ?? '';
  const apiKey = env.OPENROUTER_EVAL_API_KEY?.trim() ?? '';
  if (!stub) {
    if (!baseUrl) {
      throw new UsageError('BACKEND_URL is not set (or pass --backend URL)');
    }
    try {
      new URL(baseUrl);
    } catch {
      throw new UsageError(`backend URL is not a URL: ${baseUrl}`);
    }
    if (!apiKey) {
      throw new UsageError(
        'OPENROUTER_EVAL_API_KEY is not set (the quota guard and the judge need it)',
      );
    }
  }

  // Cases: golden files, or the fixtures when a dry run finds none.
  const dir = values.get('--dir') ? resolve(values.get('--dir')!) : DEFAULT_DIR;
  let cases = loadCasesOrThrow(dir);
  if (cases.length === 0) {
    if (!stub) throw new UsageError(`no golden cases in ${dir}; run validate`);
    cases = loadFixtureCases();
    deps.log(
      `golden directory has no cases; using the ${cases.length} fixture cases of src/runner/fixtures/`,
    );
  }

  // A stub run without --out writes to a fresh temp directory, never to results/.
  const outOption = values.get('--out') ? resolve(values.get('--out')!) : null;

  // The sink.
  let sink: EventSink;
  if (booleans.has('--no-posthog')) {
    sink = new NoopSink();
  } else if (stub && !booleans.has('--posthog')) {
    sink = new MemorySink();
  } else {
    const token = env.POSTHOG_PROJECT_TOKEN?.trim();
    if (token) {
      sink = new PostHogSink({
        token,
        host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
        fetch: deps.fetch,
        warn: deps.warn,
      });
    } else if (booleans.has('--posthog')) {
      throw new UsageError('--posthog needs POSTHOG_PROJECT_TOKEN');
    } else {
      deps.warn(
        'POSTHOG_PROJECT_TOKEN is not set: eval events will not be sent',
      );
      sink = new NoopSink();
    }
  }
  const noJudge = booleans.has('--no-judge');

  if (stub) {
    const oracle = new FakeOracle();
    const handle: StubHandle = await startStubAssistant(
      bad ? badScript(cases, oracle) : perfectScript(cases, oracle),
    );
    deps.log(
      `stub assistant (${bad ? 'failing' : 'perfect'}) at ${handle.url}`,
    );
    return {
      cases,
      stub,
      baseUrl: handle.url,
      auth: new StubAuth(),
      oracle,
      judge: noJudge ? null : fakeJudge(bad ? 1 : 5),
      sink,
      quota: null,
      outDir: outOption ?? mkdtempSync(join(tmpdir(), 'taphoa-eval-stub-')),
      today,
      concurrency,
      closeStub: () => handle.close(),
    };
  }

  const oracle = await (deps.createOracle ?? createLiveOracle)(env);
  return {
    cases,
    stub,
    baseUrl,
    auth: chooseAuth(env, deps.fetch),
    oracle,
    judge: noJudge
      ? null
      : makeJudge({
          apiKey,
          models: judgeModelsFromEnv(env),
          fetch: deps.fetch,
        }),
    sink,
    quota: { apiKey, fetch: deps.fetch },
    outDir: outOption ?? DEFAULT_OUT,
    today,
    concurrency,
    // The pg oracle holds a connection pool; others have nothing to close.
    closeStub: async () => {
      await (oracle as { close?: () => Promise<void> }).close?.();
    },
  };
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

function printSummary(run: RunSummary, log: (line: string) => void) {
  log('');
  log(
    `${'metric'.padEnd(20)} ${'value'.padStart(8)} ${'bar'.padStart(8)}  result`,
  );
  for (const row of run.aggregate.rows) {
    log(
      `${row.metric.padEnd(20)} ${formatValue(row).padStart(8)} ${row.bar.padStart(8)}  ${row.pass ? 'pass' : 'FAIL'}`,
    );
  }
  for (const f of run.aggregate.failing) {
    log(`failing: ${f.case_id} (${f.scorers.join(', ')})`);
  }
  for (const e of run.aggregate.errors) log(`error: ${e}`);
  if (run.aborted) {
    log(
      `ABORTED by ${run.aborted.code} on ${run.aborted.case_id}; not run: ${run.notRun.join(', ')}`,
    );
  }
  if (run.pending.length > 0) {
    log(`pending: ${run.pending.map((p) => p.id).join(', ')}`);
  }
  log(`results: ${run.resultsFile}`);
  log(run.pass ? 'PASS' : 'FAIL');
}

function runOptions(
  p: Prepared,
  deps: CliDeps,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): Omit<RunEvalOptions, 'set'> {
  return {
    cases: p.cases,
    baseUrl: p.baseUrl,
    auth: p.auth,
    oracle: p.oracle,
    judge: p.judge,
    sink: p.sink,
    outDir: p.outDir,
    quota: p.quota,
    today: p.today,
    concurrency: p.concurrency,
    gitSha: deps.gitSha ?? gitSha(env),
    log,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.retryDelayMs !== undefined
      ? { retryDelayMs: deps.retryDelayMs }
      : {}),
  };
}

async function runSet(
  set: 'smoke' | 'full',
  args: string[],
  env: Record<string, string | undefined>,
  deps: Required<Pick<CliDeps, 'log' | 'warn'>> & CliDeps,
): Promise<number> {
  const flags = parseFlags(
    args,
    [...RUN_BOOLEANS, '--force'],
    [...RUN_VALUES, '--model', '--ids', '--tags'],
  );
  const p = await prepare(flags, env, deps);
  try {
    const run = await runEval({
      ...runOptions(p, deps, env, deps.log),
      set,
      model: flags.values.get('--model'),
      ids: list(flags.values.get('--ids')),
      tags: list(flags.values.get('--tags')),
      force: flags.booleans.has('--force'),
    });
    printSummary(run, deps.log);
    return run.pass ? 0 : 1;
  } finally {
    await p.closeStub();
  }
}

async function compare(
  args: string[],
  env: Record<string, string | undefined>,
  deps: Required<Pick<CliDeps, 'log' | 'warn'>> & CliDeps,
): Promise<number> {
  const flags = parseFlags(args, RUN_BOOLEANS, [...RUN_VALUES, '--models']);
  const models = list(flags.values.get('--models'));
  if (!models || models.length === 0) {
    throw new UsageError('compare needs --models a,b,c');
  }
  const p = await prepare(flags, env, deps);
  try {
    const smoke = p.cases.filter((c) => c.tags.includes('smoke') && !c.pending);
    if (smoke.length === 0)
      throw new UsageError('no smoke cases to compare on');
    if (p.quota) {
      // One check for every candidate; the runs then skip their own.
      const estimate =
        models.length * estimateRequests(smoke, p.judge !== null);
      await checkQuota({
        apiKey: p.quota.apiKey,
        estimate,
        fetch: p.quota.fetch,
      });
    }
    const base = {
      ...runOptions(p, deps, env, deps.log),
      set: 'smoke' as const,
      quota: p.quota ? { ...p.quota, skipCheck: true } : null,
    };

    const rows: ModelChoiceRow[] = [];
    const judgeModels: string[] = [];
    let aborted: RunSummary['aborted'] = null;
    for (const model of models) {
      deps.log(`\n== ${model}`);
      const run = await runEval({ ...base, model });
      printSummary(run, deps.log);
      for (const j of run.judgeModels)
        if (!judgeModels.includes(j)) judgeModels.push(j);
      const metric = (name: string) =>
        run.aggregate.rows.find((r) => r.metric === name)?.value ?? null;
      rows.push({
        model,
        runId: run.runId,
        allBars: run.pass,
        judge: metric('judge'),
        facts: metric('facts'),
        tool_selection: metric('tool_selection'),
        latency_p95_ms: metric('latency_p95_ms'),
        errors: run.aggregate.errors.length,
      });
      if (run.aborted) {
        aborted = run.aborted;
        break;
      }
    }

    const md = renderModelChoice({
      date: hcmDate((deps.now ?? (() => new Date()))()),
      gitSha: base.gitSha ?? 'unknown',
      backendHost: new URL(p.baseUrl).host,
      judgeModels,
      rows,
    });
    mkdirSync(p.outDir, { recursive: true });
    const file = join(p.outDir, 'model-choice.md');
    writeFileSync(file, md);
    deps.log(`\nmodel choice: ${file}`);
    if (aborted) {
      deps.warn(`compare stopped early: ${aborted.code} on ${aborted.case_id}`);
      return 1;
    }
    return rows.some((r) => r.allBars) ? 0 : 1;
  } finally {
    await p.closeStub();
  }
}

/** Runs every oracle with its example args; `--md` writes ORACLES.md for case writers. */
async function oraclesCommand(
  args: string[],
  env: Record<string, string | undefined>,
  deps: Required<Pick<CliDeps, 'log' | 'warn'>> & CliDeps,
): Promise<number> {
  const flags = parseFlags(args, ['--md'], ['--out']);
  const db = await openEvalDatabase(env);
  try {
    const runs = await runCatalog(db.pool, {
      storeId: db.storeId,
      today: db.today,
    });
    const failed = runs.filter((r) => r.error !== null);
    if (!flags.booleans.has('--md')) {
      for (const line of renderOraclesText(runs)) deps.log(line);
      deps.log(`${runs.length} oracles, ${failed.length} failed`);
      return failed.length > 0 ? 1 : 0;
    }
    if (failed.length > 0) {
      for (const r of failed) deps.log(`${r.entry.name}: ${r.error}`);
      deps.log(`${failed.length} oracle(s) failed; ORACLES.md not written`);
      return 1;
    }
    const file = flags.values.get('--out')
      ? resolve(flags.values.get('--out')!)
      : DEFAULT_ORACLES_MD;
    writeFileSync(file, renderOraclesMd(runs, { today: db.today }));
    deps.log(
      `${runs.length} oracles written to ${relative(process.cwd(), file)}`,
    );
    return 0;
  } finally {
    await db.close();
  }
}

async function calibrateCommand(
  args: string[],
  env: Record<string, string | undefined>,
  deps: Required<Pick<CliDeps, 'log' | 'warn'>> & CliDeps,
): Promise<number> {
  const flags = parseFlags(args, [], ['--judge-model', '--file', '--out']);
  const apiKey = env.OPENROUTER_EVAL_API_KEY?.trim();
  if (!apiKey) {
    throw new UsageError(
      'OPENROUTER_EVAL_API_KEY is not set (the judge needs it)',
    );
  }
  const file = flags.values.get('--file')
    ? resolve(flags.values.get('--file')!)
    : DEFAULT_CALIBRATION;
  let items;
  try {
    items = loadCalibrationItems(file);
  } catch (e) {
    throw new UsageError(
      `${(e as Error).message}\n(the 10 hand-labelled answers are written by task T5; use --file to pick another file)`,
    );
  }
  const judgeModel = flags.values.get('--judge-model');
  const models = judgeModel ? [judgeModel] : judgeModelsFromEnv(env);
  const judge = makeJudge({ apiKey, models, fetch: deps.fetch });
  const result = await calibrate(items, (input) => judge(input, null));

  const outDir = flags.values.get('--out')
    ? resolve(flags.values.get('--out')!)
    : DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'judge-calibration.md');
  writeFileSync(
    out,
    renderCalibration(result, {
      judgeModel: models[0]!,
      date: hcmDate((deps.now ?? (() => new Date()))()),
    }),
  );
  deps.log(
    `judge ${models[0]}: agreement ${Number((result.agreement * 100).toFixed(1))} %, ` +
      `MAE ${Number(result.mae.toFixed(2))}, ${result.pass ? 'PASS' : 'FAIL'}`,
  );
  deps.log(`results: ${out}`);
  return result.pass ? 0 : 1;
}

/**
 * Pre-flight for Clerk identities: mint a token for each role. With
 * `--github-env` the tokens are masked and appended to `$GITHUB_ENV`. Tokens
 * live about 60 s, so a run must use `CLERK_SECRET_KEY` (`ClerkAuth` refreshes
 * them); exported tokens only suit a command that starts right away.
 */
async function identitiesCommand(
  args: string[],
  env: Record<string, string | undefined>,
  deps: Required<Pick<CliDeps, 'log' | 'warn'>> & CliDeps,
): Promise<number> {
  const flags = parseFlags(args, ['--github-env'], []);
  const githubEnv = env.GITHUB_ENV?.trim();
  if (flags.booleans.has('--github-env') && !githubEnv) {
    throw new UsageError(
      '--github-env needs GITHUB_ENV (set by GitHub Actions)',
    );
  }
  const clerk = ClerkAuth.fromEnv(env, deps.fetch);
  if (!clerk) {
    throw new AuthConfigError(
      'CLERK_SECRET_KEY is not set (needed to mint identities)',
    );
  }
  const roles = ['lead', 'seller'] as const;
  const minted = new Map<(typeof roles)[number], string>();
  for (const role of roles) {
    const { token } = await clerk.mintToken(role);
    minted.set(role, token);
    deps.log(`${role}: Clerk token minted`);
  }
  if (githubEnv && flags.booleans.has('--github-env')) {
    const storeId = env.EVAL_STORE_ID?.trim() || DEFAULT_EVAL_STORE_ID;
    let block = '';
    for (const [role, token] of minted) {
      deps.log(`::add-mask::${token}`);
      block += `EVAL_${role.toUpperCase()}_TOKEN=${token}\n`;
    }
    block += `EVAL_STORE_ID=${storeId}\n`;
    appendFileSync(githubEnv, block);
    deps.log(
      'EVAL_LEAD_TOKEN, EVAL_SELLER_TOKEN and EVAL_STORE_ID written to GITHUB_ENV',
    );
  }
  return 0;
}

/** Run one CLI command; returns the exit code. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  deps: CliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const full = { ...deps, log, warn };
  // `pnpm run smoke -- --stub` hands the lone `--` on to the script.
  const [command, ...rest] = argv.filter((arg, i) => i === 0 || arg !== '--');
  try {
    switch (command) {
      case 'validate':
        return validate(rest, log);
      case 'smoke':
      case 'full':
        return await runSet(command, rest, env, full);
      case 'compare':
        return await compare(rest, env, full);
      case 'calibrate':
        return await calibrateCommand(rest, env, full);
      case 'oracles':
        return await oraclesCommand(rest, env, full);
      case 'identities':
        return await identitiesCommand(rest, env, full);
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof OracleUnavailableError || e instanceof AuthConfigError) {
      console.error(e.message);
      return 2;
    }
    if (e instanceof CaseLoadError) {
      console.error(e.message);
      return 1;
    }
    // Refusals (quota, a full run already today) and failed runs.
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
