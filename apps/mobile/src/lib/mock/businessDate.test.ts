import { addDays, businessDate } from '@/lib/date';
import { summaryRange } from '@/lib/api/hooks';
import { freezeDate } from '@/test/clock';
import { newUuid } from '@/lib/uuid';

import { getMockDb, resetMockDb } from './db';
import {
  createExpense,
  getDailyReport,
  getDayClose,
  listExpenses,
  putDayClose,
} from './ledger';

// Instants are absolute (+07:00), so the suite is the same under any process TZ.
const CLOCKS = [
  ['23:59 local', '2026-10-23T23:59:00+07:00', '2026-10-23'],
  ['00:05 local', '2026-10-24T00:05:00+07:00', '2026-10-24'],
  ['07:00 local', '2026-10-24T07:00:00+07:00', '2026-10-24'],
  ['16:30 local', '2026-10-24T16:30:00+07:00', '2026-10-24'],
] as const;

describe.each(CLOCKS)('at %s', (_label, instant, today) => {
  beforeEach(() => {
    freezeDate(instant);
    resetMockDb();
  });

  test('business date is the Ho Chi Minh date', () => {
    expect(businessDate()).toBe(today);
  });

  test('seed holds nothing dated after the clock', () => {
    const now = new Date(instant).toISOString();
    const db = getMockDb();
    expect(db.expenses.filter((e) => e.spent_at > now)).toEqual([]);
    expect(db.sales.filter((s) => s.sold_at > now)).toEqual([]);
  });

  test('a new expense lists first and counts in today report', () => {
    const before = getDailyReport(today).expenses;
    const { expense } = createExpense({
      id: newUuid(),
      spent_at: new Date().toISOString(),
      amount: 50000,
      category: 'dien',
      paid_with: 'cash_box',
    });
    expect(expense.business_date).toBe(today);
    expect(listExpenses({ from: today, to: today })[0]!.id).toBe(expense.id);
    expect(listExpenses({})[0]!.id).toBe(expense.id);
    expect(getDailyReport(today).expenses).toBe(before + 50000);
    expect(getDailyReport().business_date).toBe(today);
  });

  test('day close of today and the dashboard ranges agree', () => {
    const close = putDayClose(today, {
      counted_cash: getDailyReport(today).expected_cash,
      opening_float: 0,
      note: null,
    });
    expect(close.business_date).toBe(today);
    expect(getDailyReport().day_close?.business_date).toBe(today);
    expect(getDayClose(today).business_date).toBe(today);
    const day = summaryRange('day');
    const week = summaryRange('week');
    const month = summaryRange('month');
    expect([day.to, week.to, month.to]).toEqual([today, today, today]);
    expect(day.from).toBe(addDays(today, -6));
  });
});
