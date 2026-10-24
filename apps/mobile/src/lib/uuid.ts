const hex = (value: number, length: number) =>
  value.toString(16).padStart(length, '0');

const randomBits = (bits: number) => Math.floor(Math.random() * 2 ** bits);

/** Client-generated UUIDv7 (time-ordered), as the API expects for sale, expense and product ids. */
export function newUuid(now: number = Date.now()): string {
  const time = hex(now, 12);
  const variant = hex(8 + randomBits(2), 1);
  return [
    time.slice(0, 8),
    time.slice(8),
    `7${hex(randomBits(12), 3)}`,
    `${variant}${hex(randomBits(12), 3)}`,
    hex(randomBits(24), 6) + hex(randomBits(24), 6),
  ].join('-');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The short sale code the server derives from the sale id (`money::sale_code`): the low 30 bits of
 * the id as six Crockford base32 characters. The VietQR memo carries it, so a bank statement line
 * matches `Sale.code`.
 */
export function saleCode(id: string): string {
  const tail = BigInt(`0x${id.replace(/-/g, '')}`) & ((1n << 30n) - 1n);
  let code = '';
  for (let position = 5; position >= 0; position -= 1) {
    code += CROCKFORD[Number((tail >> BigInt(position * 5)) & 31n)];
  }
  return code;
}
