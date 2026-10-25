import { describe, expect, it } from 'vitest';
import { loadOracleCatalog, type OracleEntry } from './catalog.ts';
import {
  formatArgs,
  formatSample,
  renderOraclesMd,
  renderOraclesText,
  runCatalog,
  type OracleRun,
} from './report.ts';
import type { Queryable } from './db.ts';
import type { OracleValue } from '../types.ts';

const catalog = loadOracleCatalog();
const entry = (name: string): OracleEntry =>
  catalog.find((e) => e.name === name)!;

/** One run per catalog entry, each with a canned value of its kind. */
function fakeRuns(): OracleRun[] {
  return catalog.map((e) => ({
    entry: e,
    error: null,
    value:
      e.kind === 'names'
        ? { kind: 'names', values: ['Coca-Cola lon 320ml', 'Pepsi lon 320ml'] }
        : { kind: e.kind, values: [42] },
  }));
}

describe('formatArgs', () => {
  it('writes key=value pairs, or a dash for none', () => {
    expect(formatArgs(null)).toBe('-');
    expect(formatArgs({ period: 'last_14_days', limit: 5 })).toBe(
      'period=last_14_days limit=5',
    );
  });
});

describe('formatSample', () => {
  it('lists up to five names and counts the rest', () => {
    const value: OracleValue = {
      kind: 'names',
      values: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    };
    expect(formatSample(value)).toBe('a; b; c; d; e; (+2 more)');
    expect(formatSample({ kind: 'names', values: ['a', 'b'] })).toBe('a; b');
    expect(formatSample({ kind: 'names', values: [] })).toBe('(none)');
  });

  it('prints numbers as they are', () => {
    expect(formatSample({ kind: 'money', values: [4562000] })).toBe('4562000');
    expect(formatSample({ kind: 'percent', values: [-3.1] })).toBe('-3.1');
    expect(formatSample({ kind: 'count', values: [604, 845, 479] })).toBe(
      '604, 845, 479',
    );
  });
});

describe('renderOraclesText', () => {
  it('prints name, kind, args and value on one line per oracle', () => {
    const lines = renderOraclesText([
      {
        entry: entry('sales_revenue'),
        error: null,
        value: { kind: 'money', values: [123] },
      },
      {
        entry: entry('stock_low_names'),
        error: null,
        value: { kind: 'names', values: ['Coca-Cola lon 320ml'] },
      },
      { entry: entry('sales_count'), error: 'boom', value: null },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^sales_revenue\s+money\s+period=yesterday\s+123$/,
    );
    expect(lines[1]).toMatch(
      /^stock_low_names\s+names\s+-\s+Coca-Cola lon 320ml$/,
    );
    expect(lines[2]).toMatch(
      /^sales_count\s+count\s+period=yesterday\s+ERROR: boom$/,
    );
  });
});

describe('renderOraclesMd', () => {
  const md = renderOraclesMd(fakeRuns(), { today: '2026-10-20' });
  const lines = md.split('\n');

  it('is a generated document with a title and the pinned date', () => {
    expect(lines[0]).toBe('# Oracle catalog');
    expect(md).toContain('2026-10-20');
    expect(md).toContain('node src/cli.ts oracles --md');
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('has one table row per oracle with its description and example', () => {
    for (const e of catalog) {
      const row = lines.find((l) => l.startsWith(`| \`${e.name}\``));
      expect(row, e.name).toBeDefined();
      expect(row).toContain(e.kind);
    }
    const revenue = lines.find((l) => l.startsWith('| `sales_revenue`'))!;
    expect(revenue).toContain('`period period`');
    expect(revenue).toContain('`{"period":"yesterday"}`');
  });

  it('pads every table to equal-width rows, as prettier prints them', () => {
    const tables: string[][] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line.startsWith('|')) current.push(line);
      else if (current.length > 0) {
        tables.push(current);
        current = [];
      }
    }
    if (current.length > 0) tables.push(current);
    expect(tables.length).toBeGreaterThanOrEqual(3);
    for (const table of tables) {
      const widths = new Set(table.map((l) => [...l].length));
      expect(widths.size, table[0]).toBe(1);
      expect(table[1]).toMatch(/^\| -+ \|( -+ \|)*$/);
    }
  });

  it('wraps snake_case identifiers of descriptions in code spans', () => {
    const row = lines.find((l) => l.startsWith('| `margin_thin_names`'))!;
    expect(row).toContain('`margin_negative_names`');
    expect(row).not.toMatch(/[^`]margin_negative_names[^`]/);
  });

  it('lists the oracles of each use case', () => {
    expect(md).toMatch(/^- U1: .*`stock_low_names`/m);
    expect(md).toMatch(/^- U22: .*`sales_revenue`/m);
    expect(md).toMatch(/^- PERM: .*`denied_dayclose_figures`/m);
    expect(md).not.toMatch(/^- U23:/m);
  });

  it('documents periods, arg types and refs', () => {
    expect(md).toContain('`this_week`');
    expect(md).toContain('2026-10-19..2026-10-25');
    expect(md).toContain('`receipt:draft`');
    expect(md).toContain('`receipt_line:draft#8`');
    expect(md).toContain('`expense_category`');
  });

  it('has no line with trailing spaces and escapes pipes in cells', () => {
    for (const line of lines) expect(line).toBe(line.trimEnd());
    const runs = fakeRuns();
    runs[0] = {
      entry: { ...runs[0]!.entry, describe: 'a | b' },
      error: null,
      value: runs[0]!.value,
    };
    expect(renderOraclesMd(runs, { today: '2026-10-20' })).toContain('a \\| b');
  });

  it('shows an error in the sample cell', () => {
    const runs = fakeRuns();
    runs[0] = { entry: runs[0]!.entry, value: null, error: 'boom' };
    expect(renderOraclesMd(runs, { today: '2026-10-20' })).toContain(
      'ERROR: boom',
    );
  });
});

describe('runCatalog', () => {
  it('runs every oracle with its example args and keeps going after a failure', async () => {
    const seen: string[] = [];
    const pool: Queryable = {
      async query(text) {
        seen.push(text);
        if (seen.length === 2) throw new Error('second one fails');
        // A product lookup (for oracles with a product arg) finds the product.
        if (/FROM products/.test(text) && !/ctx/.test(text)) {
          return {
            rows: [{ id: 'x', name: 'Coca-Cola lon 320ml' }],
            fields: [{ name: 'id' }, { name: 'name' }],
          };
        }
        return { rows: [{ v: 1 }], fields: [{ name: 'v' }] };
      },
    };
    const small = [
      entry('stock_low_names'),
      entry('stock_out_names'),
      entry('sales_count'),
    ];
    const runs = await runCatalog(
      pool,
      { storeId: 'e7a10e7a-0000-4000-8000-000000000000', today: '2026-10-20' },
      small,
    );
    expect(runs.map((r) => r.entry.name)).toEqual(small.map((e) => e.name));
    expect(runs[1]!.error).toMatch(/second one fails/);
    expect(runs[1]!.value).toBeNull();
    expect(runs[0]!.error).toBeNull();
    expect(runs[2]!.error).toBeNull();
  });
});
