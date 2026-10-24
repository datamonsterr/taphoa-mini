/** Banknotes offered as quick cash buttons (board 07). */
export const CASH_NOTES = [50000, 100000, 200000, 500000] as const;

/** Change to hand back; 0 while the customer has not given enough. */
export function computeChange(total: number, tendered: number): number {
  return Math.max(0, tendered - total);
}

/** "Exact" first, then the banknotes; a note equal to the total is not repeated. */
export function quickCashOptions(total: number): number[] {
  return [
    ...(total > 0 ? [total] : []),
    ...CASH_NOTES.filter((note) => note !== total),
  ];
}
