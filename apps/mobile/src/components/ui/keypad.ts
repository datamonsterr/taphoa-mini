export const DIGIT_KEYS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const;

export type KeypadKeyId = (typeof DIGIT_KEYS)[number] | '0' | '000' | 'delete';

/** Key order on the keypad, row by row. */
export const KEYPAD_LAYOUT: readonly KeypadKeyId[] = [
  ...DIGIT_KEYS,
  '000',
  '0',
  'delete',
];

/**
 * Pure reducer for a digit-string amount.
 * `value` holds digits only ("" = empty). `max` is the most digits allowed;
 * a press that would exceed it is ignored. Leading zeros are dropped.
 */
export function applyKey(value: string, key: KeypadKeyId, max: number): string {
  if (key === 'delete') return value.slice(0, -1);
  const next = String(Number(value + key));
  return next.length > max ? value : next;
}
