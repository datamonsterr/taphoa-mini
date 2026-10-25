/** Runs one oracle: validates and binds the args, runs the SQL, shapes the rows. */
import type { OracleValue } from '../types.ts';
import {
  loadOracleCatalog,
  type OracleArg,
  type OracleEntry,
} from './catalog.ts';
import type { Queryable } from './db.ts';
import {
  DateSpecError,
  isIsoDate,
  resolveDate,
  resolvePeriod,
} from './dates.ts';
import { displayName, findProduct, RefError, suggestProducts } from './refs.ts';

export type { Queryable } from './db.ts';

export type RunContext = {
  storeId: string;
  /** The pinned business date, `YYYY-MM-DD`. */
  today: string;
  args?: Record<string, string | number>;
};

/** The caller passed a wrong oracle name or wrong args. */
export class OracleArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleArgError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXPENSE_CATEGORIES = ['nhap_hang', 'dien', 'nuoc', 'khac', 'all'];

/** Names that exist in the store, for `member`, `category` and `supplier` args. */
const NAME_LOOKUPS: Record<
  'member' | 'category' | 'supplier',
  { sql: string; label: string }
> = {
  member: {
    sql: 'SELECT display_name AS name FROM members WHERE store_id = $1 AND active ORDER BY display_name',
    label: 'member',
  },
  category: {
    sql: 'SELECT name FROM categories WHERE store_id = $1 ORDER BY name',
    label: 'category',
  },
  supplier: {
    sql: String.raw`SELECT DISTINCT regexp_replace(note, '^Nhập hàng: ', '') AS name FROM expenses WHERE store_id = $1 AND category = 'nhap_hang' AND deleted_at IS NULL ORDER BY 1`,
    label: 'supplier',
  },
};

async function existingName(
  pool: Queryable,
  storeId: string,
  type: keyof typeof NAME_LOOKUPS,
  value: string,
): Promise<string> {
  const { sql, label } = NAME_LOOKUPS[type];
  const { rows } = await pool.query(sql, [storeId]);
  const names = rows.map((r) => String(r.name));
  if (names.includes(value)) return value;
  throw new OracleArgError(
    `unknown ${label} '${value}' (the store has: ${names.join(', ')})`,
  );
}

function text(arg: OracleArg, value: string | number): string {
  const s = String(value);
  if (s.trim() === '') throw new OracleArgError(`arg '${arg.name}' is empty`);
  return s;
}

/**
 * The values to send with the oracle's SQL: the store id, today, then every
 * arg in header order (a period becomes its first and last date). Checks the
 * args and resolves names against the database.
 */
export async function bindParams(
  pool: Queryable,
  entry: Pick<OracleEntry, 'name' | 'args'>,
  ctx: RunContext,
): Promise<unknown[]> {
  const { storeId, today } = ctx;
  const given = ctx.args ?? {};
  if (!UUID.test(storeId)) {
    throw new OracleArgError(
      `store id ${JSON.stringify(storeId)} is not a uuid`,
    );
  }
  if (!isIsoDate(today)) {
    throw new OracleArgError(
      `today must look like YYYY-MM-DD, got ${JSON.stringify(today)}`,
    );
  }
  for (const key of Object.keys(given)) {
    if (!entry.args.some((a) => a.name === key)) {
      const takes = entry.args.map((a) => a.name).join(', ') || 'no args';
      throw new OracleArgError(
        `${entry.name}: unknown arg '${key}' (it takes: ${takes})`,
      );
    }
  }

  const values: unknown[] = [storeId, today];
  for (const arg of entry.args) {
    const raw = given[arg.name];
    if (raw === undefined) {
      throw new OracleArgError(`${entry.name}: missing arg '${arg.name}'`);
    }
    const bad = (message: string) =>
      new OracleArgError(`${entry.name}: arg '${arg.name}' ${message}`);
    try {
      switch (arg.type) {
        case 'text':
          values.push(text(arg, raw));
          break;
        case 'int': {
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (
            !Number.isInteger(n) ||
            (typeof raw === 'string' && raw.trim() === '')
          ) {
            throw bad(`must be a whole number, got ${JSON.stringify(raw)}`);
          }
          values.push(n);
          break;
        }
        case 'date':
          values.push(resolveDate(text(arg, raw), today));
          break;
        case 'period': {
          const { from, to } = resolvePeriod(text(arg, raw), today);
          values.push(from, to);
          break;
        }
        case 'product': {
          const name = text(arg, raw);
          const found = await findProduct(pool, storeId, name);
          if (!found) {
            const similar = await suggestProducts(pool, storeId, name);
            throw bad(
              `unknown product '${name}'` +
                (similar.length > 0
                  ? `; did you mean ${similar.map((s) => `'${s}'`).join(', ')}? (use the exact catalog name)`
                  : ''),
            );
          }
          values.push(found.name);
          break;
        }
        case 'member':
        case 'category':
        case 'supplier':
          values.push(
            await existingName(pool, storeId, arg.type, text(arg, raw)),
          );
          break;
        case 'expense_category': {
          const category = text(arg, raw);
          if (!EXPENSE_CATEGORIES.includes(category)) {
            throw bad(
              `must be one of ${EXPENSE_CATEGORIES.join(', ')}, got '${category}'`,
            );
          }
          values.push(category);
          break;
        }
      }
    } catch (e) {
      if (e instanceof OracleArgError) throw e;
      if (e instanceof DateSpecError || e instanceof RefError) {
        throw bad(`${e.message}`);
      }
      throw e;
    }
  }
  return values;
}

type RowSet = {
  rows: Record<string, unknown>[];
  fields: { name: string }[];
};

function toNumber(entry: Pick<OracleEntry, 'name' | 'kind'>, raw: unknown) {
  if (raw === null || raw === undefined) {
    throw new Error(`oracle ${entry.name} returned null`);
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (typeof raw === 'boolean' || !Number.isFinite(n)) {
    throw new Error(
      `oracle ${entry.name} returned ${String(raw)}, not a number`,
    );
  }
  if (
    (entry.kind === 'count' || entry.kind === 'money') &&
    !Number.isInteger(n)
  ) {
    throw new Error(
      `oracle ${entry.name} (${entry.kind}) returned ${n}, not a whole number`,
    );
  }
  return n;
}

/**
 * The rows of an oracle query as an `OracleValue`. `names` keep their row
 * order and show product names in their display form (see `displayName`);
 * a number kind needs at least one row with a number.
 */
export function toOracleValue(
  entry: Pick<OracleEntry, 'name' | 'kind'>,
  result: RowSet,
): OracleValue {
  if (result.fields.length !== 1) {
    throw new Error(
      `oracle ${entry.name} must return one column, got ${result.fields.length}`,
    );
  }
  const column = result.fields[0]!.name;
  const cells = result.rows.map((row) => row[column]);
  if (entry.kind === 'names') {
    return {
      kind: 'names',
      values: cells.map((cell) => {
        if (cell === null || cell === undefined) {
          throw new Error(`oracle ${entry.name} returned a null name`);
        }
        return displayName(String(cell));
      }),
    };
  }
  if (cells.length === 0) {
    throw new Error(`oracle ${entry.name} returned no value (no matching row)`);
  }
  return {
    kind: entry.kind,
    values: cells.map((cell) => toNumber(entry, cell)),
  };
}

/** Runs the oracle `name` against the store and shapes its rows. */
export async function runOracle(
  pool: Queryable,
  name: string,
  ctx: RunContext,
  catalog: OracleEntry[] = loadOracleCatalog(),
): Promise<OracleValue> {
  const entry = catalog.find((e) => e.name === name);
  if (!entry) {
    throw new OracleArgError(
      `unknown oracle '${name}'${closest(name, catalog)}`,
    );
  }
  const values = await bindParams(pool, entry, ctx);
  let result: RowSet;
  try {
    result = await pool.query(entry.sql, values);
  } catch (e) {
    throw new Error(`oracle ${name}: ${(e as Error).message}`, { cause: e });
  }
  return toOracleValue(entry, result);
}

/** Up to three catalog names that share the most with a misspelled one. */
function closest(name: string, catalog: OracleEntry[]): string {
  const tokens = new Set(name.split('_'));
  const scored = catalog
    .map((e) => {
      const shared = e.name.split('_').filter((t) => tokens.has(t)).length;
      const prefix = e.name.startsWith(name) || name.startsWith(e.name) ? 5 : 0;
      return { name: e.name, score: shared + prefix };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3);
  return scored.length > 0
    ? `; closest: ${scored.map((s) => s.name).join(', ')}`
    : '';
}
