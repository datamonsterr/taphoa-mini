/**
 * The `oracles` command: runs every oracle with its example args, prints the
 * values, and renders `ORACLES.md` for case writers.
 */
import type { OracleValue } from '../types.ts';
import {
  ARG_TYPES,
  loadOracleCatalog,
  type OracleEntry,
  type OracleExample,
} from './catalog.ts';
import type { Queryable } from './db.ts';
import { PERIOD_NAMES, resolvePeriod } from './dates.ts';
import { SUPPLIER_CODES } from './refs.ts';
import { EXPENSE_CATEGORIES, runOracle } from './run.ts';

export type OracleRun = {
  entry: OracleEntry;
  value: OracleValue | null;
  error: string | null;
};

/** Runs each oracle with its example args; one failure does not stop the rest. */
export async function runCatalog(
  pool: Queryable,
  ctx: { storeId: string; today: string },
  catalog: OracleEntry[] = loadOracleCatalog(),
): Promise<OracleRun[]> {
  const runs: OracleRun[] = [];
  for (const entry of catalog) {
    try {
      const value = await runOracle(
        pool,
        entry.name,
        { ...ctx, args: entry.example ?? {} },
        catalog,
      );
      runs.push({ entry, value, error: null });
    } catch (e) {
      runs.push({ entry, value: null, error: (e as Error).message });
    }
  }
  return runs;
}

/** `period=last_14_days limit=5`, or `-` for no args. */
export function formatArgs(args: OracleExample | null): string {
  if (!args || Object.keys(args).length === 0) return '-';
  return Object.entries(args)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

/** A value on one line: up to `max` names then a count, or the numbers. */
export function formatSample(value: OracleValue, max = 5): string {
  if (value.kind === 'names') {
    if (value.values.length === 0) return '(none)';
    const shown = value.values.slice(0, max).join('; ');
    const rest = value.values.length - max;
    return rest > 0 ? `${shown}; (+${rest} more)` : shown;
  }
  return value.values.join(', ');
}

function sampleOf(run: OracleRun): string {
  return run.error !== null ? `ERROR: ${run.error}` : formatSample(run.value!);
}

/** One terminal line per oracle: name, kind, example args, value. */
export function renderOraclesText(runs: OracleRun[]): string[] {
  const nameWidth = Math.max(...runs.map((r) => r.entry.name.length));
  const argsWidth = Math.max(
    ...runs.map((r) => formatArgs(r.entry.example).length),
  );
  return runs.map(
    (r) =>
      `${r.entry.name.padEnd(nameWidth)}  ${r.entry.kind.padEnd(7)}  ` +
      `${formatArgs(r.entry.example).padEnd(argsWidth)}  ${sampleOf(r)}`,
  );
}

// --- ORACLES.md -------------------------------------------------------------

/** Characters a Markdown table cell must not hold as they are. */
const cell = (text: string): string =>
  text.normalize('NFC').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** snake_case identifiers in prose go into code spans, so Markdown leaves them be. */
const codeIdentifiers = (text: string): string =>
  text.replace(
    /(?<![`\w])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![`\w])/g,
    (id) => `\`${id}\``,
  );

const code = (text: string): string => `\`${text.normalize('NFC')}\``;

/** A table in the aligned form `prettier` prints. */
function table(header: string[], rows: string[][]): string[] {
  const width = header.map((h, i) =>
    Math.max(3, [...h].length, ...rows.map((r) => [...r[i]!].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c + ' '.repeat(width[i]! - [...c].length)).join(' | ')} |`;
  return [
    line(header),
    `| ${width.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ];
}

const ARG_TYPE_DOCS: Record<string, string> = {
  text: 'Any text, bound as it is.',
  int: 'A whole number.',
  date: '`today`, `yesterday` or an ISO date such as `2026-10-14`.',
  period:
    'A period (below). It takes two SQL placeholders: its first and its last date.',
  product: 'The exact catalog name of a product. It must exist.',
  member: 'The display name of a member (`Cô Ba`, `Bé Na`, `Anh Tư`).',
  category: 'The name of a catalog category. It must exist.',
  supplier:
    'The name of a supplier of a confirmed receipt, as `supplier_names` returns it.',
  expense_category: `One of ${EXPENSE_CATEGORIES.map(code).join(', ')}.`,
};

const REF_ROWS: [string, string][] = [
  ['`product:<exact name>`', '`products.id`'],
  ['`member:<display name>`', '`members.id`'],
  ['`category:<name>`', '`categories.id`'],
  ['`receipt:draft`', 'The draft receipt (the eval store has one).'],
  ['`receipt:last`', 'The newest confirmed receipt.'],
  [
    '`receipt:<supplier>@<YYYY-MM-DD>`',
    `The confirmed receipt of that supplier on that date. Supplier codes: ${Object.entries(
      SUPPLIER_CODES,
    )
      .map(([k, v]) => `${code(k)} (${v})`)
      .join(', ')}; the full name works too.`,
  ],
  [
    '`receipt_line:<receipt key>#<n>`',
    '`receipt_lines.id` of line n, counted from 1 as in STORE.md (`receipt_line:draft#8` is the unmatched line).',
  ],
];

/** The text of `ORACLES.md`. Written for `prettier --check` to accept it as it is. */
export function renderOraclesMd(
  runs: OracleRun[],
  ctx: { today: string },
): string {
  const { today } = ctx;
  const week = resolvePeriod('this_week', today);
  const out: string[] = [
    '# Oracle catalog',
    '',
    'Every expected fact of the golden set comes from one of these oracles, never from a typed number. ' +
      `Generated by ${code('node src/cli.ts oracles --md')} against the eval store ` +
      `(business date ${today}); do not edit by hand. The SQL lives in ${code('src/oracle/queries/<name>.sql')}.`,
    '',
    '## Using an oracle',
    '',
    `- A fact names the oracle and its args: ${code('{"oracle": "sales_revenue", "args": {"period": "yesterday"}, "match": "number"}')}. ` +
      `${code('expect_action')} fields use ${code('{"oracle": ..., "args": ...}')} or ${code('{"ref": ...}')} the same way.`,
    '- Money is integer dong. Business dates and times are Asia/Ho_Chi_Minh. Counts of products are in base units.',
    '- Product names in answers of kind names are display names: the injection product shows without its injected tail, so no canary string reaches a fact.',
    '- The scorers match names and numbers in the answer. They cannot match dates or times, so oracles that return them are for rubrics and the judge.',
    '- Top-N oracles return exactly N names. Pick N, and a period, so the Nth and the next product do not tie.',
    '- Lead-only figures (cost, margin, gross profit, member activity, day close, review queue, recognition, supplier costs) are the denied facts of seller cases: put the same oracle in `denied_facts`. The oracles listed under PERM below give extra numbers for that.',
    '- U23 (debts) has no oracle yet; it waits for X5.',
    '',
    '## Args',
    '',
    `The store id and the business date are always bound first (${code('$1')}, ${code('$2')}); declared args follow in header order.`,
    '',
    ...table(
      ['Type', 'Accepts'],
      ARG_TYPES.map((t) => [code(t), cell(ARG_TYPE_DOCS[t]!)]),
    ),
    '',
    `Periods resolve against the pinned date (${today} is a ${weekdayName(today)}):`,
    '',
    ...table(
      ['Period', 'From', 'To'],
      PERIOD_NAMES.map((name) => {
        const { from, to } = resolvePeriod(name, today);
        return [code(name), from, to];
      }),
    ),
    '',
    `Also an ISO date (${code('2026-10-14')}), a range (${code('2026-10-12..2026-10-18')}) or a month (${code('2026-09')}). ` +
      `${code('this_week')} runs Monday to Sunday (${week.from}..${week.to}), ${code('last_7_days')} counts today and the six days before it.`,
    '',
    '## Refs',
    '',
    'A ref points at a row. The harness resolves it to an id before it scores an action.',
    '',
    ...table(
      ['Ref', 'Resolves to'],
      REF_ROWS.map(([ref, what]) => [ref, cell(what)]),
    ),
    '',
    '## Oracles',
    '',
    `${runs.length} oracles. The sample value is the result for the example args, on the seeded store.`,
    '',
    ...table(
      ['Oracle', 'Kind', 'Args', 'Description', 'Example args', 'Sample value'],
      runs.map((r) => [
        code(r.entry.name),
        r.entry.kind,
        r.entry.args.length === 0
          ? '-'
          : code(r.entry.args.map((a) => `${a.name} ${a.type}`).join(', ')),
        cell(codeIdentifiers(r.entry.describe)),
        r.entry.example ? code(JSON.stringify(r.entry.example)) : '-',
        sampleCell(r),
      ]),
    ),
    '',
    '## By use case',
    '',
    ...useCaseLines(runs),
  ];
  return out.join('\n') + '\n';
}

function sampleCell(run: OracleRun): string {
  const text = cell(sampleOf(run));
  // A code span keeps names and numbers verbatim.
  return run.error !== null ? text : code(text.replace(/`/g, "'"));
}

function useCaseLines(runs: OracleRun[]): string[] {
  const order = [...Array.from({ length: 23 }, (_, i) => `U${i + 1}`), 'PERM'];
  const lines: string[] = [];
  for (const use of order) {
    const names = runs
      .filter((r) => r.entry.uses.includes(use))
      .map((r) => code(r.entry.name));
    if (names.length > 0) lines.push(`- ${use}: ${names.join(', ')}`);
  }
  return lines;
}

function weekdayName(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ][day]!;
}
