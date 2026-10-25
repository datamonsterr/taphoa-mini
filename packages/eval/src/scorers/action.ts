import type {
  FieldExpect,
  GoldenCase,
  ProposedAction,
  ResolvedCase,
} from '../types.ts';

/**
 * Key of `ResolvedCase.actionOracles`: the oracle name followed by the JSON of
 * its args (`{}` when there are none), e.g. `suggested_price{"product":"Coca"}`.
 */
export function actionOracleKey(
  oracle: string,
  args?: Record<string, string | number>,
): string {
  return `${oracle}${JSON.stringify(args ?? {})}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A number, or a numeric string; NaN for anything else. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** Deep equality where numbers (and numeric strings) compare numerically. */
function looseEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((a, i) => looseEqual(a, expected[i]))
    );
  }
  if (isRecord(actual) || isRecord(expected)) {
    if (!isRecord(actual) || !isRecord(expected)) return false;
    const keys = Object.keys(expected);
    return (
      Object.keys(actual).length === keys.length &&
      keys.every((k) => k in actual && looseEqual(actual[k], expected[k]))
    );
  }
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return actual === expected;
  }
  if (typeof actual === 'number' || typeof expected === 'number') {
    const a = toNumber(actual);
    const e = toNumber(expected);
    return !Number.isNaN(a) && a === e;
  }
  return actual === expected;
}

/** Every value a dotted path reaches; a `[]` segment fans out over an array. */
function collect(value: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) return [value];
  const [segment, ...rest] = segments as [string, ...string[]];
  const fanOut = segment.endsWith('[]');
  const key = fanOut ? segment.slice(0, -2) : segment;
  let next: unknown = value;
  if (key !== '') next = isRecord(value) ? value[key] : undefined;
  if (next === undefined) return [];
  if (!fanOut) return collect(next, rest);
  return Array.isArray(next) ? next.flatMap((el) => collect(el, rest)) : [];
}

function holds(
  actual: unknown,
  expected: FieldExpect,
  resolved: ResolvedCase,
): boolean {
  if ('ref' in expected) {
    const target = resolved.refs[expected.ref];
    return target !== undefined && looseEqual(actual, target);
  }
  if ('eq' in expected) return looseEqual(actual, expected.eq);
  if ('oracle' in expected) {
    const oracle =
      resolved.actionOracles[actionOracleKey(expected.oracle, expected.args)];
    if (!oracle) return false;
    const values: (string | number)[] = oracle.values;
    return values.some((v) => looseEqual(actual, v));
  }
  if (expected.min === undefined && expected.max === undefined) {
    return actual !== undefined && actual !== null;
  }
  const n = toNumber(actual);
  if (Number.isNaN(n)) return false;
  return (
    (expected.min === undefined || n >= expected.min) &&
    (expected.max === undefined || n <= expected.max)
  );
}

function matches(
  action: ProposedAction,
  expect: NonNullable<GoldenCase['expect_action']>,
  resolved: ResolvedCase,
): boolean {
  if (action.kind !== expect.kind) return false;
  return Object.entries(expect.fields).every(([path, expected]) =>
    collect(action.payload, path.split('.')).some((actual) =>
      holds(actual, expected, resolved),
    ),
  );
}

/**
 * 1 when any proposed action has the expected kind and every field
 * expectation holds, 0 otherwise, null when no action is expected. Field
 * paths are dotted and relative to the action payload; `items[].product_id`
 * accepts any element of `items`.
 */
export function scoreAction(
  actions: ProposedAction[],
  expect: GoldenCase['expect_action'],
  resolved: ResolvedCase,
): 0 | 1 | null {
  if (expect === null) return null;
  return actions.some((a) => matches(a, expect, resolved)) ? 1 : 0;
}
