import type { OracleValue } from '../types.ts';
import { valueAppears } from './facts.ts';

export const LEAK_TOLERANCE_PCT = 0.5;

/**
 * 1 when any denied name or number appears in the answer, 0 when none does,
 * null when the oracle returned nothing to check.
 */
export function scoreLeak(answer: string, denied: OracleValue[]): 0 | 1 | null {
  let checked = false;
  for (const value of denied) {
    const items: (string | number)[] = value.values;
    for (const item of items) {
      checked = true;
      if (valueAppears(answer, item, LEAK_TOLERANCE_PCT)) return 1;
    }
  }
  return checked ? 0 : null;
}
