import { showVoiceSaleChip } from './chipRule';

const now = Date.parse('2026-10-28T09:00:00Z');
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

test.each([
  [0, 0, true],
  [13, 2, true],
  [14, 0, false],
  [30, 0, false],
  [1, 3, false],
  [1, 10, false],
])('joined %s days ago with %s voice sales -> %s', (days, sales, expected) => {
  expect(
    showVoiceSaleChip({ joinedAt: daysAgo(days), voiceSales: sales, now }),
  ).toBe(expected);
});

test('no join date or an unreadable one hides the chip', () => {
  expect(showVoiceSaleChip({ joinedAt: undefined, voiceSales: 0, now })).toBe(
    false,
  );
  expect(showVoiceSaleChip({ joinedAt: 'soon', voiceSales: 0, now })).toBe(
    false,
  );
});
