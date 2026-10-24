import { newUuid, saleCode } from './uuid';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('newUuid returns a valid UUIDv7', () => {
  for (let i = 0; i < 50; i += 1) expect(newUuid()).toMatch(UUID_V7);
});

test('newUuid embeds the timestamp so ids sort by time', () => {
  const a = newUuid(1_000_000_000_000);
  const b = newUuid(1_000_000_000_001);
  expect(a < b).toBe(true);
});

test('newUuid is unique across calls', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newUuid()));
  expect(ids.size).toBe(200);
});

describe('saleCode', () => {
  test('is the low 30 bits of the id as six Crockford characters (money::sale_code)', () => {
    expect(saleCode('0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b')).toBe('77T71V');
    expect(saleCode('00000000-0000-7000-8000-000000000000')).toBe('000000');
    expect(saleCode('ffffffff-ffff-7fff-bfff-ffffffffffff')).toBe('ZZZZZZ');
  });

  test('always yields six characters of the alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(saleCode(newUuid())).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });
});
