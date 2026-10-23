/** Deterministic UUID for seed data, e.g. seedUuid(12) -> 00000000-0000-4000-8000-00000000000c. */
export function seedUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Random base32 string (sale codes, invite tokens). */
export function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE32.charAt(Math.floor(Math.random() * BASE32.length));
  }
  return out;
}
