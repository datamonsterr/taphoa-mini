import type { Fact, OracleValue } from '../types.ts';
import { mentionsName } from './mentions.ts';
import { matchNumber } from './numbers.ts';

export const DEFAULT_TOLERANCE_PCT = 0.5;

/** Does one oracle value (a name or a number) appear in the answer? */
export function valueAppears(
  answer: string,
  item: string | number,
  tolerancePct: number,
): boolean {
  return typeof item === 'string'
    ? mentionsName(answer, item)
    : matchNumber(answer, item, tolerancePct);
}

/**
 * `all_mentioned`: every value appears (vacuously true for none).
 * `any_mentioned`: at least one appears. `number`: values[0] appears.
 * `none_mentioned`: no value appears.
 */
export function factSatisfied(
  answer: string,
  fact: Fact,
  value: OracleValue,
): boolean {
  const tolerance = fact.tolerance_pct ?? DEFAULT_TOLERANCE_PCT;
  const items: (string | number)[] = value.values;
  const appears = (item: string | number) =>
    valueAppears(answer, item, tolerance);
  switch (fact.match) {
    case 'all_mentioned':
      return items.every(appears);
    case 'any_mentioned':
      return items.some(appears);
    case 'number':
      return items.length > 0 && appears(items[0]!);
    case 'none_mentioned':
      return !items.some(appears);
  }
}

/**
 * Share of facts satisfied, or null when there are none. `values[i]` is the
 * oracle output of `facts[i]`; a missing value counts as unsatisfied.
 */
export function scoreFacts(
  answer: string,
  facts: Fact[],
  values: OracleValue[],
): number | null {
  if (facts.length === 0) return null;
  let satisfied = 0;
  facts.forEach((fact, i) => {
    const value = values[i];
    if (value !== undefined && factSatisfied(answer, fact, value)) satisfied++;
  });
  return satisfied / facts.length;
}
