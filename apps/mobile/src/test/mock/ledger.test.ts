import { addDays, businessDate } from '@/lib/date';
import { newUuid } from '@/lib/uuid';
import type { CreateSaleRequest } from '@/lib/api/types';

import {
  getMockDb,
  getProduct,
  listAlerts,
  patchStore,
  resetMockDb,
} from './db';
import { PRODUCT_IDS } from './fixtures';
import {
  createExpense,
  createSale,
  getDailyReport,
  getDayClose,
  getSummaryReport,
  listExpenses,
  listSales,
  putDayClose,
} from './ledger';

beforeEach(resetMockDb);

const today = () => businessDate();
const line = (
  productId: string | null,
  quantity: number,
  unit_price: number,
  extra: object = {},
) => ({
  id: newUuid(),
  product_id: productId,
  source: productId ? ('camera' as const) : ('manual' as const),
  quantity,
  unit_price,
  ...extra,
});
const sale = (over: Partial<CreateSaleRequest> = {}): CreateSaleRequest => ({
  id: newUuid(),
  sold_at: new Date().toISOString(),
  payment_method: 'cash',
  cash_received: 50000,
  total: 29000,
  lines: [line(PRODUCT_IDS.coca, 2, 10000), line(PRODUCT_IDS.pepsi, 1, 9000)],
  ...over,
});

describe('createSale', () => {
  test('records a cash sale: totals, change, payment method', () => {
    const { sale: s, created } = createSale(sale());
    expect(created).toBe(true);
    expect(s).toMatchObject({
      payment_method: 'cash',
      total: 29000,
      cash_received: 50000,
      change_given: 21000,
      vietqr_memo: null,
      status: 'completed',
      business_date: today(),
    });
    expect(s.lines[0]).toMatchObject({
      line_total: 20000,
      price_mismatch: false,
      product_name: 'Coca-Cola lon 330ml',
    });
  });

  test('transfer sale gets a memo with the store prefix and no cash fields', () => {
    const { sale: s } = createSale(
      sale({ payment_method: 'transfer', cash_received: undefined }),
    );
    expect(s.cash_received).toBeNull();
    expect(s.change_given).toBeNull();
    expect(s.vietqr_memo).toBe(`TH ${s.code}`);
    const { sale: kept } = createSale(
      sale({ payment_method: 'transfer', vietqr_memo: 'TH ABC' }),
    );
    expect(kept.vietqr_memo).toBe('TH ABC');
  });

  test('cash_received defaults to the total', () => {
    const { sale: s } = createSale(sale({ cash_received: undefined }));
    expect([s.cash_received, s.change_given]).toEqual([29000, 0]);
  });

  test('is idempotent on id', () => {
    const req = sale();
    createSale(req);
    const replay = createSale(req);
    expect(replay.created).toBe(false);
  });

  test('units are accepted; manual lines have no product', () => {
    const unit = getProduct(PRODUCT_IDS.coca).units[0]!;
    const { sale: s } = createSale(
      sale({
        cash_received: undefined,
        total: unit.price + 5000,
        lines: [
          line(PRODUCT_IDS.coca, 1, unit.price, { unit_id: unit.id }),
          line(null, 1, 5000, { manual_label: 'Kẹo' }),
        ],
      }),
    );
    expect(s.lines[1]).toMatchObject({
      product_name: null,
      price_mismatch: false,
    });
  });

  test('flags a price mismatch', () => {
    const { sale: s } = createSale(
      sale({ total: 9000, lines: [line(PRODUCT_IDS.coca, 1, 9000)] }),
    );
    expect(s.lines[0]!.price_mismatch).toBe(true);
  });

  test.each([
    ['total_mismatch', sale({ total: 1 })],
    ['unknown_product', sale({ total: 100, lines: [line(newUuid(), 1, 100)] })],
    [
      'unknown_unit',
      sale({
        total: 10000,
        lines: [line(PRODUCT_IDS.coca, 1, 10000, { unit_id: newUuid() })],
      }),
    ],
    ['cash_short', sale({ cash_received: 100 })],
  ])('rejects %s with 400', (code, req) => {
    expect(() => createSale(req)).toThrow(
      expect.objectContaining({ status: 400, code }),
    );
  });

  test('listSales filters and orders newest first', () => {
    createSale(sale({ payment_method: 'transfer' }));
    const all = listSales({});
    expect(all[0]!.sold_at >= all[1]!.sold_at).toBe(true);
    expect(
      listSales({
        paymentMethod: 'transfer',
        from: today(),
        to: today(),
      }).every((s) => s.payment_method === 'transfer'),
    ).toBe(true);
    expect(listSales({ status: 'voided' })).toEqual([]);
    expect(
      listSales({ memberId: getMockDb().members[1]!.id }).every(
        (s) => s.member_id === getMockDb().members[1]!.id,
      ),
    ).toBe(true);
    expect(listSales({ from: addDays(today(), 1) })).toEqual([]);
  });
});

describe('createExpense', () => {
  const expense = (over = {}) => ({
    id: newUuid(),
    spent_at: new Date().toISOString(),
    amount: 50000,
    category: 'khac' as const,
    paid_with: 'cash_box' as const,
    ...over,
  });

  test('is stored, listed, idempotent and updates the report', () => {
    const before = getDailyReport(today());
    const req = expense();
    expect(createExpense(req)).toMatchObject({
      created: true,
      expense: { business_date: today(), alerts: [], image: null },
    });
    expect(createExpense(req).created).toBe(false);
    const after = getDailyReport(today());
    expect(after.expenses).toBe(before.expenses + 50000);
    expect(after.net).toBe(before.net - 50000);
    expect(after.expected_cash).toBe(
      Math.max(0, before.expected_cash! - 50000),
    );
    expect(
      listExpenses({ category: 'khac', from: today() }).some(
        (e) => e.id === req.id,
      ),
    ).toBe(true);
    expect(
      listExpenses({ category: 'dien', from: today(), to: today() }),
    ).toEqual([]);
  });

  test('"other" payments do not reduce expected cash', () => {
    const before = getDailyReport(today());
    createExpense(expense({ paid_with: 'other', category: 'dien' }));
    expect(getDailyReport(today()).expected_cash).toBe(before.expected_cash);
  });

  test('purchase lines set cost per base unit and raise margin alerts', () => {
    const unit = getProduct(PRODUCT_IDS.coca).units[0]!;
    const { expense: e } = createExpense(
      expense({
        category: 'nhap_hang',
        purchase_lines: [
          {
            product_id: PRODUCT_IDS.coca,
            unit_id: unit.id,
            quantity: 2,
            unit_cost: 240000,
          },
        ],
      }),
    );
    expect(getProduct(PRODUCT_IDS.coca).cost_price).toBe(10000);
    expect(e.alerts).toHaveLength(1);
    expect(listAlerts('open').some((a) => a.expense_id === e.id)).toBe(true);
  });

  test('image must exist; unknown purchase product / unit -> 400', () => {
    expect(() => createExpense(expense({ image_id: newUuid() }))).toThrow(
      expect.objectContaining({ code: 'unknown_image' }),
    );
    const image = [...getMockDb().images.values()][0]!;
    expect(
      createExpense(expense({ image_id: image.id })).expense.image,
    ).toEqual(image);
    expect(() =>
      createExpense(
        expense({
          purchase_lines: [
            { product_id: newUuid(), quantity: 1, unit_cost: 1 },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'unknown_product' }));
    expect(() =>
      createExpense(
        expense({
          purchase_lines: [
            {
              product_id: PRODUCT_IDS.coca,
              unit_id: newUuid(),
              quantity: 1,
              unit_cost: 1,
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'unknown_unit' }));
  });

  test('no alert when the margin stays above the store threshold', () => {
    patchStore({ margin_threshold_pct: 0 });
    const { expense: e } = createExpense(
      expense({
        purchase_lines: [
          { product_id: PRODUCT_IDS.coca, quantity: 1, unit_cost: 9000 },
        ],
      }),
    );
    expect(e.alerts).toEqual([]);
  });

  test('a seller purchase keeps the cost price; the Lead purchase updates it', () => {
    const seller = getMockDb().members.find((m) => m.role !== 'lead')!;
    const lines = [
      { product_id: PRODUCT_IDS.coca, quantity: 1, unit_cost: 4321 },
    ];
    const before = getProduct(PRODUCT_IDS.coca).cost_price;
    const openAlerts = listAlerts('open').length;
    getMockDb().currentMemberId = seller.id;
    createExpense(
      expense({ amount: 4321, category: 'nhap_hang', purchase_lines: lines }),
    );
    expect(getProduct(PRODUCT_IDS.coca).cost_price).toBe(before);
    expect(listAlerts('open')).toHaveLength(openAlerts);

    const lead = getMockDb().members.find((m) => m.role === 'lead')!;
    getMockDb().currentMemberId = lead.id;
    createExpense(
      expense({ amount: 4321, category: 'nhap_hang', purchase_lines: lines }),
    );
    expect(getProduct(PRODUCT_IDS.coca).cost_price).toBe(4321);
  });
});

describe('reports', () => {
  test('daily report sums the day; sales move revenue, cash and transfer', () => {
    const before = getDailyReport();
    createSale(sale());
    createSale(sale({ payment_method: 'transfer', cash_received: undefined }));
    const after = getDailyReport();
    expect(after).toMatchObject({
      business_date: today(),
      sales_count: before.sales_count + 2,
      revenue: before.revenue + 58000,
      cash_revenue: before.cash_revenue + 29000,
      transfer_revenue: before.transfer_revenue + 29000,
      net: before.net + 58000,
      day_close: null,
    });
    expect(after.revenue).toBe(after.cash_revenue + after.transfer_revenue);
    expect(getDailyReport('2000-01-01')).toMatchObject({
      revenue: 0,
      sales_count: 0,
      expected_cash: 0,
    });
  });

  test('summary buckets: day, week (clipped, Mon-Sun), month (clipped)', () => {
    const to = today();
    const from = addDays(to, -6);
    const days = getSummaryReport(from, to, 'day');
    expect(days.buckets).toHaveLength(7);
    expect(
      days.buckets.every(
        (b) => b.start === b.end && b.net === b.revenue - b.expenses,
      ),
    ).toBe(true);
    const total = days.buckets.reduce((t, b) => t + b.revenue, 0);

    const weeks = getSummaryReport(from, to, 'week');
    expect(weeks.buckets[0]!.start).toBe(from);
    expect(weeks.buckets.at(-1)!.end).toBe(to);
    expect(weeks.buckets.reduce((t, b) => t + b.revenue, 0)).toBe(total);

    const months = getSummaryReport('2026-01-15', '2026-03-10', 'month');
    expect(months.buckets.map((b) => [b.start, b.end])).toEqual([
      ['2026-01-15', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-10'],
    ]);
  });

  test('summary rejects reversed and over-long ranges', () => {
    expect(() => getSummaryReport('2026-10-02', '2026-10-01', 'day')).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => getSummaryReport('2025-01-01', '2026-10-01', 'day')).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(
      getSummaryReport('2025-10-01', '2026-09-30', 'month').buckets,
    ).toHaveLength(12);
  });
});

describe('day close', () => {
  test('expected cash = opening float + cash sales - cash expenses; difference = counted - expected', () => {
    const date = today();
    createSale(sale());
    createExpense({
      id: newUuid(),
      spent_at: new Date().toISOString(),
      amount: 20000,
      category: 'khac',
      paid_with: 'cash_box',
    });
    createExpense({
      id: newUuid(),
      spent_at: new Date().toISOString(),
      amount: 99000,
      category: 'dien',
      paid_with: 'other',
    });
    const report = getDailyReport(date);
    const cashOut = getMockDb()
      .expenses.filter(
        (e) => e.business_date === date && e.paid_with === 'cash_box',
      )
      .reduce((t, e) => t + e.amount, 0);
    const expected = 20000 + report.cash_revenue - cashOut;
    const close = putDayClose(date, {
      counted_cash: expected - 5000,
      opening_float: 20000,
      note: 'Thiếu 5k',
    });
    expect(close).toMatchObject({
      business_date: date,
      opening_float: 20000,
      cash_sales: report.cash_revenue,
      cash_expenses: cashOut,
      cash_refunds: 0,
      expected_cash: expected,
      difference: -5000,
      transfer_revenue: report.transfer_revenue,
      note: 'Thiếu 5k',
    });
    expect(getDayClose(date)).toBe(close);
    expect(getDailyReport(date).day_close).toBe(close);
  });

  test('seeded days never expect negative cash', () => {
    for (let back = 0; back < 7; back += 1) {
      const date = addDays(today(), -back);
      const cashIn = listSales({
        from: date,
        to: date,
        paymentMethod: 'cash',
      }).reduce((t, s) => t + s.total, 0);
      const cashOut = listExpenses({ from: date, to: date })
        .filter((e) => e.paid_with === 'cash_box')
        .reduce((t, e) => t + e.amount, 0);
      expect(cashIn - cashOut).toBeGreaterThanOrEqual(0);
    }
  });

  test('can be re-closed (PUT replaces) and clamps negative expected cash to 0', () => {
    putDayClose('2000-01-01', {
      counted_cash: 5,
      opening_float: 0,
      note: null,
    });
    expect(
      putDayClose('2000-01-01', {
        counted_cash: 7,
        opening_float: 0,
        note: null,
      }).counted_cash,
    ).toBe(7);
    createExpense({
      id: newUuid(),
      spent_at: '2000-01-01T05:00:00Z',
      amount: 1000,
      category: 'khac',
      paid_with: 'cash_box',
    });
    expect(
      putDayClose('2000-01-01', {
        counted_cash: 0,
        opening_float: 0,
        note: null,
      }),
    ).toMatchObject({ expected_cash: 0, difference: 0 });
  });

  test('404 when the day is not closed', () => {
    expect(() => getDayClose('2000-02-02')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('manual sale lines', () => {
  const manualSale = (over: Partial<CreateSaleRequest> = {}) =>
    sale({
      total: 6000,
      cash_received: undefined,
      lines: [line(null, 2, 3000, { manual_label: 'Kẹo' })],
      ...over,
    });

  test('a manual line is queued for review and counted in the daily report', () => {
    const open = getMockDb().manualLines.length;
    const before = getDailyReport(today()).manual_lines_open;
    const { sale: s } = createSale(manualSale());
    const added = getMockDb().manualLines.at(-1)!;
    expect(getMockDb().manualLines).toHaveLength(open + 1);
    expect(added).toMatchObject({
      line_id: s.lines[0]!.id,
      sale_id: s.id,
      sold_by: s.member_id,
      unit_price: 3000,
      quantity: 2,
      manual_label: 'Kẹo',
      reason: 'manual_price',
      status: 'open',
      crop_image: null,
    });
    expect(getDailyReport(today()).manual_lines_open).toBe(before! + 1);
  });

  test('catalog lines and replays do not add manual lines; no label -> null', () => {
    const count = getMockDb().manualLines.length;
    createSale(sale());
    const req = manualSale({ lines: [line(null, 1, 6000)] });
    createSale(req);
    createSale(req);
    expect(getMockDb().manualLines).toHaveLength(count + 1);
    expect(getMockDb().manualLines.at(-1)!.manual_label).toBeNull();
  });
});
