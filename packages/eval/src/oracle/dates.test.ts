import { describe, expect, it } from 'vitest';
import {
  addDays,
  DateSpecError,
  isIsoDate,
  PERIOD_NAMES,
  resolveDate,
  resolvePeriod,
} from './dates.ts';

// 2026-10-20 is a Tuesday: the eval store's pinned business date.
const TODAY = '2026-10-20';
const range = (from: string, to: string = from) => ({ from, to });

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isIsoDate('2026-10-20')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-10-32')).toBe(false);
    expect(isIsoDate('20/10/2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
});

describe('addDays', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-10-20', 1)).toBe('2026-10-21');
    expect(addDays('2026-10-20', -20)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('resolvePeriod on Tuesday 2026-10-20', () => {
  it.each([
    ['today', range('2026-10-20')],
    ['yesterday', range('2026-10-19')],
    ['this_week', range('2026-10-19', '2026-10-25')],
    ['last_week', range('2026-10-12', '2026-10-18')],
    ['last_7_days', range('2026-10-14', '2026-10-20')],
    ['prev_7_days', range('2026-10-07', '2026-10-13')],
    ['last_14_days', range('2026-10-07', '2026-10-20')],
    ['prev_14_days', range('2026-09-23', '2026-10-06')],
    ['last_30_days', range('2026-09-21', '2026-10-20')],
    ['prev_30_days', range('2026-08-22', '2026-09-20')],
    ['this_month', range('2026-10-01', '2026-10-31')],
    ['last_month', range('2026-09-01', '2026-09-30')],
    ['this_quarter', range('2026-10-01', '2026-12-31')],
    ['last_quarter', range('2026-07-01', '2026-09-30')],
    ['year_to_date', range('2026-01-01', '2026-10-20')],
    ['2026-10-14', range('2026-10-14')],
    ['2026-10-12..2026-10-18', range('2026-10-12', '2026-10-18')],
    ['2026-09', range('2026-09-01', '2026-09-30')],
  ])('%s', (spec, expected) => {
    expect(resolvePeriod(spec, TODAY)).toEqual(expected);
  });

  it('resolves this_week to Monday..Sunday on every weekday', () => {
    // Monday 19th through Sunday 25th all see the same week.
    for (const day of [19, 20, 21, 22, 23, 24, 25]) {
      expect(resolvePeriod('this_week', `2026-10-${day}`)).toEqual(
        range('2026-10-19', '2026-10-25'),
      );
    }
    expect(resolvePeriod('this_week', '2026-10-26')).toEqual(
      range('2026-10-26', '2026-11-01'),
    );
  });

  it('accepts names in any letter case and with stray spaces', () => {
    expect(resolvePeriod('  Yesterday ', TODAY)).toEqual(range('2026-10-19'));
  });
});

describe('resolvePeriod at calendar edges', () => {
  it('last_month and last_quarter cross the year boundary', () => {
    expect(resolvePeriod('last_month', '2026-01-15')).toEqual(
      range('2025-12-01', '2025-12-31'),
    );
    expect(resolvePeriod('last_quarter', '2026-02-10')).toEqual(
      range('2025-10-01', '2025-12-31'),
    );
    expect(resolvePeriod('this_quarter', '2026-02-10')).toEqual(
      range('2026-01-01', '2026-03-31'),
    );
  });

  it('knows month lengths and leap years', () => {
    expect(resolvePeriod('this_month', '2028-02-10')).toEqual(
      range('2028-02-01', '2028-02-29'),
    );
    expect(resolvePeriod('2026-02', TODAY)).toEqual(
      range('2026-02-01', '2026-02-28'),
    );
    expect(resolvePeriod('last_month', '2026-03-31')).toEqual(
      range('2026-02-01', '2026-02-28'),
    );
  });

  it('this_week crosses a month boundary', () => {
    expect(resolvePeriod('this_week', '2026-09-30')).toEqual(
      range('2026-09-28', '2026-10-04'),
    );
  });
});

describe('resolvePeriod rejects', () => {
  it.each([
    'tomorrow',
    '',
    'last_year',
    '2026-02-30',
    '2026-13',
    '2026-10-20..2026-10-19',
    '2026-10-01..soon',
    '10/20/2026',
  ])('%j', (spec) => {
    expect(() => resolvePeriod(spec, TODAY)).toThrow(DateSpecError);
  });

  it('rejects a bad pinned date', () => {
    expect(() => resolvePeriod('today', '2026-02-30')).toThrow(DateSpecError);
  });

  it('names the accepted forms', () => {
    expect(() => resolvePeriod('tomorrow', TODAY)).toThrow(/this_week/);
  });
});

describe('resolveDate', () => {
  it('resolves today, yesterday and ISO dates', () => {
    expect(resolveDate('today', TODAY)).toBe('2026-10-20');
    expect(resolveDate('yesterday', TODAY)).toBe('2026-10-19');
    expect(resolveDate('2026-10-14', TODAY)).toBe('2026-10-14');
  });

  it('rejects ranges and other period names', () => {
    expect(() => resolveDate('this_week', TODAY)).toThrow(DateSpecError);
    expect(() => resolveDate('2026-10-12..2026-10-18', TODAY)).toThrow(
      DateSpecError,
    );
    expect(() => resolveDate('2026-02-30', TODAY)).toThrow(DateSpecError);
  });
});

describe('PERIOD_NAMES', () => {
  it('lists every name the task asks for', () => {
    for (const name of [
      'today',
      'yesterday',
      'this_week',
      'last_7_days',
      'prev_7_days',
      'last_14_days',
      'last_30_days',
    ]) {
      expect(PERIOD_NAMES).toContain(name);
    }
  });

  it('only lists names that resolve', () => {
    for (const name of PERIOD_NAMES) {
      expect(() => resolvePeriod(name, TODAY)).not.toThrow();
    }
  });
});
