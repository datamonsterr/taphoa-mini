import { buildDigestCaption, firstSentence, formatDayMonth } from './utils';
import { DigestCard, DigestScreen, digestStrings } from './index';

describe('index exports', () => {
  it('exports DigestCard, DigestScreen, and digestStrings', () => {
    expect(DigestCard).toBeDefined();
    expect(DigestScreen).toBeDefined();
    expect(digestStrings).toBeDefined();
  });
});

describe('firstSentence', () => {
  it('extracts the first sentence ending with a period followed by space', () => {
    expect(
      firstSentence('Doanh thu hôm nay là 1.234.000 ₫. Cần nhập 2 món.'),
    ).toBe('Doanh thu hôm nay là 1.234.000 ₫.');
  });

  it('handles dot between numbers without splitting currency numbers', () => {
    expect(firstSentence('Doanh thu đạt 1.000.000 ₫.')).toBe(
      'Doanh thu đạt 1.000.000 ₫.',
    );
  });

  it('extracts sentence ending with exclamation or question mark', () => {
    expect(firstSentence('Tuyệt vời! Tiếp tục phát huy.')).toBe('Tuyệt vời!');
    expect(firstSentence('Có 2 hóa đơn mới? Kiểm tra ngay.')).toBe(
      'Có 2 hóa đơn mới?',
    );
  });

  it('returns trimmed string if no sentence-ending punctuation', () => {
    expect(firstSentence('  Doanh thu hôm nay ổn định  ')).toBe(
      'Doanh thu hôm nay ổn định',
    );
  });
});

describe('formatDayMonth', () => {
  it('formats YYYY-MM-DD as d/M', () => {
    expect(formatDayMonth('2026-10-26')).toBe('26/10');
    expect(formatDayMonth('2026-05-04')).toBe('4/5');
  });

  it('falls back to input if not a valid YYYY-MM-DD', () => {
    expect(formatDayMonth('hello')).toBe('hello');
    expect(formatDayMonth('2026-aa-bb')).toBe('2026-aa-bb');
  });
});

describe('buildDigestCaption', () => {
  const fakeT = (key: string) => {
    if (key === 'restockCount') return '{count} cần nhập';
    if (key === 'overdueCount') return '{count} nợ quá hạn';
    return key;
  };

  it('combines restock and overdue debts when both > 0', () => {
    expect(buildDigestCaption(2, 3, fakeT)).toBe('2 cần nhập · 3 nợ quá hạn');
  });

  it('shows only restock when overdue is 0', () => {
    expect(buildDigestCaption(5, 0, fakeT)).toBe('5 cần nhập');
  });

  it('shows only overdue when restock is 0', () => {
    expect(buildDigestCaption(0, 4, fakeT)).toBe('4 nợ quá hạn');
  });

  it('returns empty string when both are 0', () => {
    expect(buildDigestCaption(0, 0, fakeT)).toBe('');
  });
});
