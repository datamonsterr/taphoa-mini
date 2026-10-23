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
