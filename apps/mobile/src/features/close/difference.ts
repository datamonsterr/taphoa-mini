import { differenceStatus, type DifferenceStatus } from '@/components/ui';

/** Most digits the keypad accepts for a cash amount (board: 10). */
export const MAX_CASH_DIGITS = 10;

/** counted − expected, with the pill status: match, short (negative) or extra. */
export function closeDifference(
  counted: number,
  expected: number,
): { difference: number; status: DifferenceStatus } {
  const difference = counted - expected;
  return { difference, status: differenceStatus(difference) };
}

/** Keypad digit string to đồng ("" = 0). */
export const countedFromDigits = (digits: string): number => Number(digits);

/** `dd/MM` of a `YYYY-MM-DD` business date. */
export const dayMonth = (date: string): string =>
  `${date.slice(8, 10)}/${date.slice(5, 7)}`;
