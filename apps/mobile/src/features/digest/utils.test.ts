import {
  buildDigestCaption,
  firstSentence,
  formatDayMonth,
  formatDigestStamp,
  summarySegments,
  weekdayName,
} from './utils';
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

describe('formatDigestStamp', () => {
  it('writes the weekday, day/month and the local generation time', () => {
    expect(formatDigestStamp('2026-10-27', '2026-10-26T23:59:00Z')).toBe(
      'Thứ ba, 27/10 · 06:59',
    );
    expect(formatDigestStamp('2026-11-01', '2026-10-31T17:00:00Z')).toBe(
      'Chủ nhật, 1/11 · 00:00',
    );
  });

  it('drops the time when the generation instant is missing or invalid', () => {
    expect(formatDigestStamp('2026-10-26')).toBe('Thứ hai, 26/10');
    expect(formatDigestStamp('2026-10-26', 'nope')).toBe('Thứ hai, 26/10');
  });

  it('falls back to the raw date when it cannot be parsed', () => {
    expect(weekdayName('bad')).toBe('');
    expect(formatDigestStamp('bad')).toBe('bad');
  });
});

describe('summarySegments', () => {
  it('bolds money and order counts and keeps the rest plain', () => {
    expect(
      summarySegments(
        'Hôm qua bán 32 đơn, doanh thu 1.240.000đ, tăng 8% so với hôm kia.',
      ),
    ).toEqual([
      { text: 'Hôm qua bán ', bold: false },
      { text: '32 đơn', bold: true },
      { text: ', doanh thu ', bold: false },
      { text: '1.240.000đ', bold: true },
      { text: ', tăng 8% so với hôm kia.', bold: false },
    ]);
  });

  it('also bolds the older 20.000 ₫ wording and passes plain text through', () => {
    expect(summarySegments('Doanh thu 20.000 ₫.')).toEqual([
      { text: 'Doanh thu ', bold: false },
      { text: '20.000 ₫', bold: true },
      { text: '.', bold: false },
    ]);
    expect(summarySegments('Hôm qua chưa có đơn nào.')).toEqual([
      { text: 'Hôm qua chưa có đơn nào.', bold: false },
    ]);
    expect(summarySegments('')).toEqual([]);
  });
});
