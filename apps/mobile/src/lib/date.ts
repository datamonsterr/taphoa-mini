const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toUtc = (date: string) => new Date(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Business date (`YYYY-MM-DD`) of an instant in Asia/Ho_Chi_Minh. */
export function businessDate(at: Date | string | number = new Date()): string {
  return toDate(new Date(at).getTime() + VN_OFFSET_MS);
}

export function isDateString(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(toUtc(value).getTime())
    ? toDate(toUtc(value).getTime()) === value
    : false;
}

export function addDays(date: string, days: number): string {
  return toDate(toUtc(date).getTime() + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / DAY_MS);
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const weekday = (toUtc(date).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const d = toUtc(startOfMonth(date));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return addDays(toDate(d.getTime()), -1);
}

/** First day of the month `months` months before the month of `date`. */
export function subMonths(date: string, months: number): string {
  const d = toUtc(startOfMonth(date));
  d.setUTCMonth(d.getUTCMonth() - months);
  return toDate(d.getTime());
}
