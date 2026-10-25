/**
 * Relative dates of oracle arguments, resolved against the pinned business
 * date (`today`, Asia/Ho_Chi_Minh) before they are bound to SQL. Dates are
 * plain `YYYY-MM-DD` strings; the arithmetic runs on UTC midnights so the
 * machine's time zone never matters.
 */

export type DateRange = { from: string; to: string };

/** A date or period spec that cannot be resolved. */
export class DateSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateSpecError';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A real calendar date in `YYYY-MM-DD` form (2026-02-30 is not one). */
export function isIsoDate(text: string): boolean {
  const m = ISO_DATE.exec(text);
  if (!m) return false;
  const date = toUtc(text);
  return !Number.isNaN(date.getTime()) && fromUtc(date) === text;
}

export function addDays(iso: string, days: number): string {
  return fromUtc(new Date(toUtc(iso).getTime() + days * DAY_MS));
}

/** The Monday of the week that holds `iso`. */
export function mondayOf(iso: string): string {
  const daysSinceMonday = (toUtc(iso).getUTCDay() + 6) % 7;
  return addDays(iso, -daysSinceMonday);
}

function monthRange(year: number, month: number): DateRange {
  // Month 0..11; a month outside that range rolls over into the next year.
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: fromUtc(first), to: fromUtc(last) };
}

function quarterRange(year: number, quarter: number): DateRange {
  // Quarter 0..3 of `year`; -1 is the last quarter of the year before.
  const start = new Date(Date.UTC(year, quarter * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3 + 3, 0));
  return { from: fromUtc(start), to: fromUtc(end) };
}

type Resolver = (today: string) => DateRange;

const day =
  (offset: number): Resolver =>
  (today) => {
    const date = addDays(today, offset);
    return { from: date, to: date };
  };

/** The `n` business dates ending `endOffset` days before today. */
const trailing =
  (n: number, endOffset = 0): Resolver =>
  (today) => ({
    from: addDays(today, -endOffset - (n - 1)),
    to: addDays(today, -endOffset),
  });

const NAMED: Record<string, Resolver> = {
  today: day(0),
  yesterday: day(-1),
  this_week: (today) => {
    const monday = mondayOf(today);
    return { from: monday, to: addDays(monday, 6) };
  },
  last_week: (today) => {
    const monday = addDays(mondayOf(today), -7);
    return { from: monday, to: addDays(monday, 6) };
  },
  last_7_days: trailing(7),
  prev_7_days: trailing(7, 7),
  last_14_days: trailing(14),
  prev_14_days: trailing(14, 14),
  last_30_days: trailing(30),
  prev_30_days: trailing(30, 30),
  this_month: (today) => {
    const d = toUtc(today);
    return monthRange(d.getUTCFullYear(), d.getUTCMonth());
  },
  last_month: (today) => {
    const d = toUtc(today);
    return monthRange(d.getUTCFullYear(), d.getUTCMonth() - 1);
  },
  this_quarter: (today) => {
    const d = toUtc(today);
    return quarterRange(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3));
  },
  last_quarter: (today) => {
    const d = toUtc(today);
    return quarterRange(
      d.getUTCFullYear(),
      Math.floor(d.getUTCMonth() / 3) - 1,
    );
  },
  year_to_date: (today) => ({
    from: `${today.slice(0, 4)}-01-01`,
    to: today,
  }),
};

/** Every period name; the first seven are the ones golden cases mostly use. */
export const PERIOD_NAMES: readonly string[] = [
  'today',
  'yesterday',
  'this_week',
  'last_7_days',
  'prev_7_days',
  'last_14_days',
  'last_30_days',
  'last_week',
  'prev_14_days',
  'prev_30_days',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'year_to_date',
];

const ACCEPTED =
  'today, yesterday, this_week, last_week, last_7_days, prev_7_days, last_14_days, prev_14_days, ' +
  'last_30_days, prev_30_days, this_month, last_month, this_quarter, last_quarter, year_to_date, ' +
  'an ISO date (2026-10-14), a range (2026-10-12..2026-10-18) or a month (2026-09)';

function checkToday(today: string): void {
  if (!isIsoDate(today)) {
    throw new DateSpecError(
      `today must look like YYYY-MM-DD, got ${JSON.stringify(today)}`,
    );
  }
}

/**
 * A period spec to dates: a name (`this_week` is Monday to Sunday, `last_7_days`
 * is today and the six days before it), an ISO date, a `from..to` range or a
 * `YYYY-MM` month.
 */
export function resolvePeriod(spec: string, today: string): DateRange {
  checkToday(today);
  const text = spec.trim().toLowerCase();
  const named = Object.hasOwn(NAMED, text) ? NAMED[text] : undefined;
  if (named) return named(today);
  if (isIsoDate(text)) return { from: text, to: text };
  const range = /^(.+)\.\.(.+)$/.exec(text);
  if (range && isIsoDate(range[1]!) && isIsoDate(range[2]!)) {
    if (range[1]! > range[2]!) {
      throw new DateSpecError(`range ${text} ends before it starts`);
    }
    return { from: range[1]!, to: range[2]! };
  }
  const month = ISO_MONTH.exec(text);
  if (month) {
    const m = Number(month[2]);
    if (m >= 1 && m <= 12) return monthRange(Number(month[1]), m - 1);
  }
  throw new DateSpecError(
    `cannot read the period ${JSON.stringify(spec)}; use ${ACCEPTED}`,
  );
}

/** A single date: `today`, `yesterday` or an ISO date. */
export function resolveDate(spec: string, today: string): string {
  checkToday(today);
  const text = spec.trim().toLowerCase();
  if (text === 'today') return today;
  if (text === 'yesterday') return addDays(today, -1);
  if (isIsoDate(text)) return text;
  throw new DateSpecError(
    `cannot read the date ${JSON.stringify(spec)}; use today, yesterday or an ISO date such as 2026-10-14`,
  );
}
