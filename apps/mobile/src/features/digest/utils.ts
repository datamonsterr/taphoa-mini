import { clockTime } from '@/lib/date';
import { fill } from '@/lib/i18n';

/**
 * Extracts the first sentence of a text, being careful not to split inside numbers
 * with decimal/thousands dot separators (e.g. 1.234.000 ₫).
 */
export function firstSentence(text: string): string {
  const match = text.match(/.*?[.!?](?!\d)(?:\s|$)/);
  return (match ? match[0] : text).trim();
}

/** Formats a YYYY-MM-DD business date as `d/M` in Vietnamese (e.g. 26/10, 4/5). */
export function formatDayMonth(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[2], 10);
    const month = parseInt(parts[1], 10);
    if (!Number.isNaN(day) && !Number.isNaN(month)) {
      return `${day}/${month}`;
    }
  }
  return dateStr;
}

/**
 * Builds the card caption `{restock.length} cần nhập · {overdue_debts.count} nợ quá hạn`,
 * hiding zero parts.
 */
export function buildDigestCaption(
  restockCount: number,
  overdueCount: number,
  t: (key: string) => string,
): string {
  const parts: string[] = [];
  if (restockCount > 0) {
    parts.push(fill(t('restockCount'), { count: restockCount }));
  }
  if (overdueCount > 0) {
    parts.push(fill(t('overdueCount'), { count: overdueCount }));
  }
  return parts.join(' · ');
}

const WEEKDAYS = [
  'Chủ nhật',
  'Thứ hai',
  'Thứ ba',
  'Thứ tư',
  'Thứ năm',
  'Thứ sáu',
  'Thứ bảy',
];

/** Vietnamese weekday of a YYYY-MM-DD business date (Thứ hai); empty when unparsable. */
export function weekdayName(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return '';
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

/**
 * Board header line (Thứ hai, 27/10 · 07:00): the weekday and day/month of the business date,
 * then the generation time in Asia/Ho_Chi_Minh (UTC+7, no daylight saving).
 */
export function formatDigestStamp(
  businessDate: string,
  generatedAt?: string,
): string {
  const day = weekdayName(businessDate);
  const date = formatDayMonth(businessDate);
  const head = day ? day + ', ' + date : date;
  if (!generatedAt) return head;
  const time = clockTime(generatedAt);
  return time ? head + ' · ' + time : head;
}

export type SummarySegment = { text: string; bold: boolean };

/**
 * Splits the summary so the key figures (money such as 1.240.000đ and counts such as 32 đơn)
 * can render bold, as on the board. Plain text stays plain.
 */
export function summarySegments(text: string): SummarySegment[] {
  const figure = /(\d[\d.]*\s?(?:đơn|đ|₫))/g;
  const segments: SummarySegment[] = [];
  let last = 0;
  for (const match of text.matchAll(figure)) {
    const start = match.index ?? 0;
    if (start > last)
      segments.push({ text: text.slice(last, start), bold: false });
    segments.push({ text: match[0], bold: true });
    last = start + match[0].length;
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), bold: false });
  return segments;
}
