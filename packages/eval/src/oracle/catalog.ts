/**
 * The oracle catalog: one SQL file per oracle in `queries/`, each opened by a
 * header of `-- key: value` comment lines.
 *
 * ```sql
 * -- oracle: sales_revenue
 * -- kind: money
 * -- args: period period
 * -- uses: U2, U10, U22
 * -- describe: Revenue of completed sales in a period, in dong.
 * -- example: {"period":"yesterday"}
 * WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
 * SELECT ...
 * ```
 *
 * Placeholders: `$1` is the store id, `$2` the business date `today`, and the
 * declared args follow from `$3` in header order. An arg takes one placeholder,
 * except a `period`, which takes two (`from`, `to`). Every placeholder must
 * appear in the SQL, so each query opens with a `ctx` CTE that names them.
 * The query returns one column: one row per name for `names`, one row for a
 * number kind (a list oracle may return several).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const ORACLE_KINDS = [
  'names',
  'number',
  'money',
  'percent',
  'count',
] as const;
export type OracleKind = (typeof ORACLE_KINDS)[number];

/**
 * `text` and `int` are bound as given. `date` resolves `today`, `yesterday` or
 * an ISO date; `period` resolves to a from/to pair. `product`, `member`,
 * `category` and `supplier` are exact names that must exist in the store;
 * `expense_category` is `nhap_hang`, `dien`, `nuoc`, `khac` or `all`.
 */
export const ARG_TYPES = [
  'text',
  'int',
  'date',
  'period',
  'product',
  'member',
  'category',
  'supplier',
  'expense_category',
] as const;
export type OracleArgType = (typeof ARG_TYPES)[number];

export type OracleArg = {
  name: string;
  type: OracleArgType;
  /** The first placeholder of the arg (`$3` for the first declared arg). */
  param: number;
};

export type OracleExample = Record<string, string | number>;

export type OracleEntry = {
  name: string;
  kind: OracleKind;
  args: OracleArg[];
  /** Use cases (`U1`..`U23`) the oracle serves, or `PERM` for permission facts. */
  uses: string[];
  describe: string;
  example: OracleExample | null;
  sql: string;
  file: string;
};

export class OracleCatalogError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'OracleCatalogError';
  }
}

export const QUERIES_DIR = join(import.meta.dirname, 'queries');

const HEADER_KEYS = [
  'oracle',
  'kind',
  'args',
  'uses',
  'describe',
  'example',
] as const;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const USE_PATTERN = /^(?:U(?:[1-9]|1\d|2[0-3])|PERM)$/;

/** Placeholders a type occupies after the store id and today. */
export function widthOf(type: OracleArgType): number {
  return type === 'period' ? 2 : 1;
}

/**
 * The `$n` placeholders of a query in ascending order, ignoring comments and
 * string literals.
 */
export function placeholdersOf(sql: string): number[] {
  const found = new Set<number>();
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
    } else if (c === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (/\d/.test(sql[j] ?? '')) j++;
      found.add(Number(sql.slice(i + 1, j)));
      i = j;
    } else {
      i++;
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Splits a file into its header lines and the SQL after them. */
function splitHeader(text: string): {
  header: Map<string, string>;
  sql: string;
  errors: string[];
} {
  const header = new Map<string, string>();
  const errors: string[] = [];
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    if (!line.startsWith('--')) break;
    const m = /^--\s*([a-z]+):\s?(.*)$/.exec(line);
    if (!m) continue; // a plain comment line
    const key = m[1]!;
    if (!(HEADER_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown header '${key}'`);
    } else if (header.has(key)) {
      errors.push(`duplicate header '${key}'`);
    } else {
      header.set(key, m[2]!.trim());
    }
  }
  return { header, sql: lines.slice(i).join('\n').trim(), errors };
}

function parseArgs(file: string, text: string): OracleArg[] {
  const args: OracleArg[] = [];
  let param = 3;
  for (const part of text.split(',')) {
    const bits = part.trim().split(/\s+/);
    if (bits.length !== 2 || bits[0] === '') {
      throw new OracleCatalogError(
        file,
        `bad arg '${part.trim()}' (expected '<name> <type>')`,
      );
    }
    const [name, type] = bits as [string, string];
    if (!NAME_PATTERN.test(name)) {
      throw new OracleCatalogError(file, `bad arg name '${name}'`);
    }
    if (!(ARG_TYPES as readonly string[]).includes(type)) {
      throw new OracleCatalogError(
        file,
        `unknown arg type '${type}' (known: ${ARG_TYPES.join(', ')})`,
      );
    }
    if (args.some((a) => a.name === name)) {
      throw new OracleCatalogError(file, `duplicate arg '${name}'`);
    }
    args.push({ name, type: type as OracleArgType, param });
    param += widthOf(type as OracleArgType);
  }
  return args;
}

function parseExample(
  file: string,
  text: string | undefined,
  args: OracleArg[],
): OracleExample | null {
  if (text === undefined) {
    if (args.length > 0) {
      throw new OracleCatalogError(
        file,
        `an oracle with args needs '-- example:' with a JSON object of ${args.map((a) => a.name).join(', ')}`,
      );
    }
    return null;
  }
  if (args.length === 0) {
    throw new OracleCatalogError(file, 'example without args');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new OracleCatalogError(
      file,
      `example is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OracleCatalogError(file, 'example must be a JSON object');
  }
  const example = parsed as Record<string, unknown>;
  for (const arg of args) {
    if (!(arg.name in example)) {
      throw new OracleCatalogError(file, `example is missing '${arg.name}'`);
    }
  }
  for (const [key, value] of Object.entries(example)) {
    if (!args.some((a) => a.name === key)) {
      throw new OracleCatalogError(file, `example has '${key}', not an arg`);
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new OracleCatalogError(
        file,
        `example '${key}' must be a string or a number`,
      );
    }
  }
  return example as OracleExample;
}

/** Parses and validates one query file; `file` is its name or path. */
export function parseOracleSql(file: string, text: string): OracleEntry {
  const fail = (message: string) => new OracleCatalogError(file, message);
  const { header, sql, errors } = splitHeader(text);
  if (errors[0]) throw fail(errors[0]);

  const need = (key: (typeof HEADER_KEYS)[number]): string => {
    const value = header.get(key);
    if (value === undefined || value === '') {
      throw fail(`missing '-- ${key}:' in the header`);
    }
    return value;
  };

  const name = need('oracle');
  if (!NAME_PATTERN.test(name)) {
    throw fail(`oracle name '${name}' must be lower_snake_case`);
  }
  const base = basename(file).replace(/\.sql$/, '');
  if (name !== base) {
    throw fail(`oracle name '${name}' does not match the file name '${base}'`);
  }
  const kind = need('kind');
  if (!(ORACLE_KINDS as readonly string[]).includes(kind)) {
    throw fail(`unknown kind '${kind}' (known: ${ORACLE_KINDS.join(', ')})`);
  }
  const uses = need('uses')
    .split(',')
    .map((u) => u.trim());
  for (const use of uses) {
    if (!USE_PATTERN.test(use)) {
      throw fail(`bad use '${use}' (expected U1..U23 or PERM)`);
    }
  }
  const describe = need('describe');
  const args = header.has('args') ? parseArgs(file, header.get('args')!) : [];
  const example = parseExample(file, header.get('example'), args);

  if (sql === '') throw fail('no SQL after the header');
  const declared = 2 + args.reduce((n, a) => n + widthOf(a.type), 0);
  const used = placeholdersOf(sql);
  const tooHigh = used.find((n) => n > declared);
  if (tooHigh !== undefined) {
    throw fail(
      `SQL uses $${tooHigh} but the header declares only $1..$${declared} ` +
        `($1 store, $2 today, then the args; a period takes two)`,
    );
  }
  for (let n = 1; n <= declared; n++) {
    if (!used.includes(n)) throw fail(`SQL never uses $${n}`);
  }

  return {
    name,
    kind: kind as OracleKind,
    args,
    uses,
    describe,
    example,
    sql,
    file,
  };
}

/** Parses many files and rejects duplicate oracle names. */
export function buildCatalog(
  files: { file: string; text: string }[],
): OracleEntry[] {
  const entries: OracleEntry[] = [];
  const seen = new Map<string, string>();
  for (const { file, text } of files) {
    const entry = parseOracleSql(file, text);
    const first = seen.get(entry.name);
    if (first !== undefined) {
      throw new OracleCatalogError(
        file,
        `duplicate oracle '${entry.name}' (also in ${first})`,
      );
    }
    seen.set(entry.name, file);
    entries.push(entry);
  }
  return entries;
}

let cached: OracleEntry[] | null = null;

/** Every oracle of `queries/`, sorted by name. Cached after the first load. */
export function loadOracleCatalog(): OracleEntry[] {
  cached ??= buildCatalog(
    readdirSync(QUERIES_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({
        file: f,
        text: readFileSync(join(QUERIES_DIR, f), 'utf8'),
      })),
  );
  return cached;
}

/** The names of every oracle, for `checkCoverage`. */
export const ORACLE_NAMES: Set<string> = new Set(
  loadOracleCatalog().map((e) => e.name),
);
