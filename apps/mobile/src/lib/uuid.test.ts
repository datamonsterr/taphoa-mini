import { newUuid } from './uuid';

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
