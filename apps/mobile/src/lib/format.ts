/** VND money as shown on the boards: integer đồng, "." thousands separator, "đ" suffix. */
export function formatVnd(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    '.',
  );
  return `${sign}${digits}đ`;
}

/** Parse "12.000đ", "12000" or "-4.500 đ" to integer đồng. Returns 0 when there are no digits. */
export function parseVnd(text: string): number {
  const digits = text.replace(/\D/g, '');
  if (digits === '') return 0;
  const value = Number(digits);
  return /^\s*-/.test(text) ? -value : value;
}
