import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Quota } from './quota.ts';
import type { Aggregate, CaseResult } from './scorers/aggregate.ts';
import { formatValue } from './scorers/aggregate.ts';

/** `partial` marks a run narrowed by `--ids` or `--tags`; it never counts as the daily full run. */
export type RunSet = 'smoke' | 'full' | 'partial';

export type PendingInfo = { id: string; on: string; reason: string };

export type RunReport = {
  runId: string;
  set: RunSet;
  model: string;
  /** Judge models that scored at least one case; empty when the judge was off. */
  judgeModels: string[];
  gitSha: string;
  /** Asia/Ho_Chi_Minh date, YYYY-MM-DD. */
  date: string;
  backendHost: string;
  quotaBefore: Quota | null;
  quotaAfter: Quota | null;
  aggregate: Aggregate;
  results: CaseResult[];
  pending: PendingInfo[];
  /** Selected cases that never ran because the run was aborted. */
  notRun: string[];
  aborted: { code: string; message: string; case_id: string } | null;
  /** Cases the judge could not score. */
  unjudged: string[];
};

/** The calendar date of `now` in Asia/Ho_Chi_Minh, as YYYY-MM-DD. */
export function hcmDate(now: Date): string {
  // The en-CA locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A model id as a file name part: `/`, `:` and anything unsafe become `-`. */
export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** `<dir>/<date>-<slug>.md`, with `-smoke` or `-partial` before the extension. */
export function resultsPath(
  dir: string,
  date: string,
  model: string,
  set: RunSet,
): string {
  const suffix = set === 'full' ? '' : `-${set}`;
  return join(dir, `${date}-${modelSlug(model)}${suffix}.md`);
}

/**
 * Is there a results file of a full run for `date`? Smoke and partial files,
 * other dates, and the summary files (`model-choice.md`,
 * `judge-calibration.md`) do not count.
 */
export function fullRunExists(dir: string, date: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) =>
      e.isFile() &&
      e.name.startsWith(`${date}-`) &&
      e.name.endsWith('.md') &&
      !e.name.endsWith('-smoke.md') &&
      !e.name.endsWith('-partial.md'),
  );
}

const cell = (text: string) =>
  text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

const pct = (x: number | null) =>
  x === null ? 'n/a' : `${Number((x * 100).toFixed(1))} %`;

const EXCERPT_LENGTH = 120;

function excerpt(result: CaseResult | undefined): string {
  if (!result) return '';
  const text = result.turn.answer.replace(/\s+/g, ' ').trim();
  if (text === '' && result.turn.error)
    return `(error ${result.turn.error.code})`;
  const short =
    text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}...` : text;
  return cell(short);
}

function quotaText(quota: Quota | null): string {
  return quota
    ? `${quota.used} used / ${quota.limit} limit, ${quota.remaining} remaining${quota.unit ? ' USD' : ''}`
    : 'n/a';
}

/** Deterministic Markdown for one run: the same report gives the same text. */
export function renderResults(run: RunReport): string {
  const resultOf = new Map(run.results.map((r) => [r.case.id, r]));
  const verdict = run.aborted
    ? 'ABORTED'
    : run.aggregate.pass
      ? 'PASS'
      : 'FAIL';
  const lines: string[] = [
    `# Eval run ${run.runId}`,
    '',
    `- Result: ${verdict}`,
    `- Set: ${run.set}`,
    `- Model: ${run.model}`,
    `- Judge model: ${run.judgeModels.length > 0 ? run.judgeModels.join(', ') : 'none'}`,
    `- Git SHA: ${run.gitSha}`,
    `- Date: ${run.date} (Asia/Ho_Chi_Minh)`,
    `- Backend: ${run.backendHost}`,
    `- Quota before: ${quotaText(run.quotaBefore)}`,
    `- Quota after: ${quotaText(run.quotaAfter)}`,
    `- Cases: ${run.results.length} scored, ${run.pending.length} pending, ${run.notRun.length} not run`,
    '',
  ];

  const costs = run.results
    .flatMap((r) => r.turn.turn_costs_usd ?? [])
    .sort((a, b) => a - b);
  if (costs.length)
    lines.push(
      `- Usage-accounted turns: ${costs.length}`,
      `- Cost per turn mean USD: ${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(8)}`,
      `- Cost per turn p95 USD: ${costs[Math.ceil(costs.length * 0.95) - 1]!.toFixed(8)}`,
      `- Assistant usage total USD: ${costs.reduce((a, b) => a + b, 0).toFixed(8)}`,
      '',
    );
  if (run.aborted) {
    lines.push(
      `> ABORTED by ${run.aborted.code} on ${run.aborted.case_id}: ${cell(run.aborted.message)}`,
      `> Not run: ${run.notRun.length > 0 ? run.notRun.join(', ') : 'none'}`,
      '',
    );
  }

  lines.push(
    '## Pass bars',
    '',
    '| Metric | Value | Bar | Cases | Result |',
    '| ------ | ----- | --- | ----- | ------ |',
    ...run.aggregate.rows.map(
      (row) =>
        `| ${row.metric} | ${formatValue(row)} | ${row.bar} | ${row.n} | ${row.pass ? 'pass' : 'FAIL'} |`,
    ),
    '',
    '## Per use case',
    '',
    '| Use case | Cases | Tool selection | Facts | Judge pass | Failing |',
    '| -------- | ----- | -------------- | ----- | ---------- | ------- |',
    ...run.aggregate.byUseCase.map(
      (u) =>
        `| ${u.use_case} | ${u.n} | ${pct(u.tool_selection)} | ${pct(u.facts)} | ${pct(u.judge_pass)} | ${u.failing.length > 0 ? u.failing.join(', ') : '-'} |`,
    ),
    '',
    '## Failing cases',
    '',
  );
  if (run.aggregate.failing.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(
      '| Case | Failed scorers | Answer excerpt |',
      '| ---- | -------------- | -------------- |',
      ...run.aggregate.failing.map(
        (f) =>
          `| ${f.case_id} | ${f.scorers.join(', ')} | ${excerpt(resultOf.get(f.case_id))} |`,
      ),
      '',
    );
  }

  if (run.aggregate.errors.length > 0) {
    lines.push(
      '## Errors',
      '',
      ...run.aggregate.errors.map((e) => `- ${cell(e)}`),
      '',
    );
  }
  if (run.unjudged.length > 0) {
    lines.push(
      '## Unjudged cases',
      '',
      `The judge gave no score for: ${run.unjudged.join(', ')}.`,
      '',
    );
  }
  if (run.pending.length > 0) {
    lines.push(
      '## Pending cases',
      '',
      'Left out of every figure above.',
      '',
      '| Case | Waiting on | Reason |',
      '| ---- | ---------- | ------ |',
      ...run.pending.map((p) => `| ${p.id} | ${p.on} | ${cell(p.reason)} |`),
      '',
    );
  }
  return lines.join('\n');
}

export type ModelChoiceRow = {
  model: string;
  runId: string;
  /** Every pass bar met. */
  allBars: boolean;
  judge: number | null;
  facts: number | null;
  tool_selection: number | null;
  latency_p95_ms: number | null;
  errors: number;
};

/** Higher is better; a missing figure ranks last. */
const high = (x: number | null) => x ?? -1;
/** Latency is compared to 0.1 s, the precision of the table: faster by milliseconds is a tie. */
const low = (x: number | null) =>
  x === null ? Number.POSITIVE_INFINITY : Math.round(x / 100);

/**
 * Best model first: all bars passed, then judge pass, facts, tool selection
 * (higher is better), then latency p95 (lower is better). Ties keep the order
 * given.
 */
export function rankModels(rows: ModelChoiceRow[]): ModelChoiceRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        Number(b.row.allBars) - Number(a.row.allBars) ||
        high(b.row.judge) - high(a.row.judge) ||
        high(b.row.facts) - high(a.row.facts) ||
        high(b.row.tool_selection) - high(a.row.tool_selection) ||
        low(a.row.latency_p95_ms) - low(b.row.latency_p95_ms) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/** Markdown for `results/model-choice.md`. */
export function renderModelChoice(input: {
  date: string;
  gitSha: string;
  backendHost: string;
  judgeModels: string[];
  rows: ModelChoiceRow[];
}): string {
  const ranked = rankModels(input.rows);
  const best = ranked[0];
  const seconds = (ms: number | null) =>
    ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    '# Model choice',
    '',
    `- Date: ${input.date} (Asia/Ho_Chi_Minh)`,
    `- Set: smoke`,
    `- Judge model: ${input.judgeModels.length > 0 ? input.judgeModels.join(', ') : 'none'}`,
    `- Git SHA: ${input.gitSha}`,
    `- Backend: ${input.backendHost}`,
    '',
    best === undefined
      ? 'No models were compared.'
      : best.allBars
        ? `Winner: ${best.model}`
        : `Winner: none. No candidate met every bar; the closest is ${best.model}.`,
    '',
    '| Rank | Model | All bars | Judge pass | Facts | Tool selection | Latency p95 | Errors | Run |',
    '| ---- | ----- | -------- | ---------- | ----- | -------------- | ----------- | ------ | --- |',
    ...ranked.map(
      (r, i) =>
        `| ${i + 1} | ${r.model} | ${r.allBars ? 'yes' : 'no'} | ${pct(r.judge)} | ${pct(r.facts)} | ${pct(r.tool_selection)} | ${seconds(r.latency_p95_ms)} | ${r.errors} | ${r.runId} |`,
    ),
    '',
    'Ranking: all bars passed, then judge pass, facts, tool selection, then latency p95.',
    '',
  ];
  return lines.join('\n');
}
