/** Banknotes offered as quick cash buttons (board 07). */
export const CASH_NOTES = [50000, 100000, 200000, 500000] as const;

/** Change to hand back; 0 while the customer has not given enough. */
export function computeChange(total: number, tendered: number): number {
  return Math.max(0, tendered - total);
}

/**
 * The four banknote buttons of board 07 (a 2x2 grid). The exact amount is the default, with no
 * button: tapping the selected note again goes back to it.
 */
export function quickCashOptions(): number[] {
  return [...CASH_NOTES];
}
