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
