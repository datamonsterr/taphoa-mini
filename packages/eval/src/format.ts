import type { OracleValue } from './types.ts';

/** `1234000` as `1.234.000`; a fraction gets a decimal comma (`12,5`). */
export function formatNumber(n: number): string {
  const sign = n < 0 ? '-' : '';
  const [int = '0', frac] = Math.abs(n).toString().split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped}${frac ? `,${frac}` : ''}`;
}

/** Money the way the assistant prompt asks for it: `1.234.000 ₫`. */
export function formatMoney(dong: number): string {
  return `${formatNumber(Math.round(dong))} ₫`;
}

/** An oracle value as it would appear in a good answer. */
export function renderValue(value: OracleValue): string {
  switch (value.kind) {
    case 'names':
      return value.values.join(', ');
    case 'money':
      return value.values.map(formatMoney).join(', ');
    case 'percent':
      return value.values.map((v) => `${formatNumber(v)}%`).join(', ');
    default:
      return value.values.map(formatNumber).join(', ');
  }
}
