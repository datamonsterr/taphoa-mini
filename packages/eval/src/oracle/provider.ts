import { createHash } from 'node:crypto';
import { actionOracleKey } from '../scorers/index.ts';
import type { Fact, GoldenCase, OracleValue, ResolvedCase } from '../types.ts';

export type OracleQuery =
  Fact | { oracle: string; args?: Record<string, string | number> };

/**
 * Where expected values come from. The live implementation (task T3) runs
 * oracle SQL against the eval database; `FakeOracle` serves dry runs.
 */
export interface OracleProvider {
  value(query: OracleQuery): Promise<OracleValue>;
  /** "product:<name>", "receipt:<key>" or "member:<name>" to the row id. */
  resolveRef(ref: string): Promise<string>;
}

/** Canned values for the oracle names used by the dry-run fixture cases. */
const DEFAULT_CANNED: Record<string, OracleValue> = {
  restock_top3_names: {
    kind: 'names',
    values: [
      'Mì Hảo Hảo tôm chua cay',
      'Nước suối Aquafina 500ml',
      'Sting dâu 330ml',
    ],
  },
  revenue_yesterday: { kind: 'money', values: [4_562_000] },
  sale_count_yesterday: { kind: 'count', values: [38] },
  dead_stock_names: {
    kind: 'names',
    values: ['Bột giặt Omo 800g', 'Dầu gội Clear 170ml'],
  },
  margin_thin_names: { kind: 'names', values: ['Trứng gà vỉ 10'] },
  margin_thin_pct: { kind: 'percent', values: [3.4] },
  suggested_price: { kind: 'money', values: [11_000] },
  pepsi_units_yesterday: { kind: 'count', values: [17] },
  overdue_debtor_names: { kind: 'names', values: ['Chị Lan', 'Anh Hùng'] },
};

function digest(text: string): Buffer {
  return createHash('sha1').update(text).digest();
}

/** A stable number in [0, 2^32) derived from text. */
function hashInt(text: string): number {
  return digest(text).readUInt32BE(0);
}

function kindOf(oracle: string): OracleValue['kind'] {
  if (/(^|_)names?($|_)|_list$/.test(oracle)) return 'names';
  if (/pct|percent/.test(oracle)) return 'percent';
  if (/count|units|qty|quantity/.test(oracle)) return 'count';
  return 'money';
}

/** A value that depends only on the oracle name and args. */
function derive(oracle: string, args: Record<string, string | number> = {}) {
  const seed = oracle + JSON.stringify(args);
  const n = hashInt(seed);
  switch (kindOf(oracle)) {
    case 'names': {
      const tag = (n % 0xffff).toString(16).padStart(4, '0');
      return {
        kind: 'names',
        values: [`Sản phẩm mẫu ${tag}a`, `Sản phẩm mẫu ${tag}b`],
      } satisfies OracleValue;
    }
    case 'percent':
      return {
        kind: 'percent',
        values: [1 + (n % 590) / 10],
      } satisfies OracleValue;
    case 'count':
      return { kind: 'count', values: [2 + (n % 98)] } satisfies OracleValue;
    default:
      return {
        kind: 'money',
        values: [50_000 + (n % 9_900) * 1000],
      } satisfies OracleValue;
  }
}

/**
 * Deterministic values for dry runs and tests. A name in `canned` returns its
 * value; any other name derives one from the name and args, shaped by a hint
 * in the name (`*_names`, `*_pct`, `*_count`), so a dry run over real golden
 * cases works without a database.
 */
export class FakeOracle implements OracleProvider {
  readonly canned: Record<string, OracleValue>;

  constructor(canned: Record<string, OracleValue> = {}) {
    this.canned = { ...DEFAULT_CANNED, ...canned };
  }

  async value(query: OracleQuery): Promise<OracleValue> {
    return Object.hasOwn(this.canned, query.oracle)
      ? this.canned[query.oracle]!
      : derive(query.oracle, query.args);
  }

  async resolveRef(ref: string): Promise<string> {
    const hex = digest(`taphoa-eval-fake:${ref}`).toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      `a${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join('-');
  }
}

/**
 * Oracle output for one case: the facts and denied values by index, the ids
 * behind `ref` field expectations, and the oracle values behind `oracle`
 * field expectations (keyed with `actionOracleKey`).
 */
export async function resolveCase(
  c: GoldenCase,
  provider: OracleProvider,
): Promise<ResolvedCase> {
  const facts = await Promise.all(c.expect_facts.map((f) => provider.value(f)));
  const denied = await Promise.all(
    (c.denied_facts ?? []).map((f) => provider.value(f)),
  );
  const refs: Record<string, string> = {};
  const actionOracles: Record<string, OracleValue> = {};
  for (const expected of Object.values(c.expect_action?.fields ?? {})) {
    if ('ref' in expected) {
      refs[expected.ref] ??= await provider.resolveRef(expected.ref);
    } else if ('oracle' in expected) {
      const key = actionOracleKey(expected.oracle, expected.args);
      actionOracles[key] ??= await provider.value(expected);
    }
  }
  return { facts, denied, refs, actionOracles };
}

/**
 * Remembers every answer, so a question asked twice (a pre-flight check, then
 * the real call) reaches the database once. A failed answer is forgotten.
 */
export function memoizeOracle(provider: OracleProvider): OracleProvider {
  const values = new Map<string, Promise<OracleValue>>();
  const refs = new Map<string, Promise<string>>();
  return {
    value(query) {
      const key = actionOracleKey(query.oracle, query.args);
      let hit = values.get(key);
      if (!hit) {
        hit = provider.value(query);
        values.set(key, hit);
        hit.catch(() => values.delete(key));
      }
      return hit;
    },
    resolveRef(ref) {
      let hit = refs.get(ref);
      if (!hit) {
        hit = provider.resolveRef(ref);
        refs.set(ref, hit);
        hit.catch(() => refs.delete(ref));
      }
      return hit;
    },
  };
}
