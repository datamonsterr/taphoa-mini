import { recordEntry, validateSaleCredit, reverseSaleCredit } from './debts';
import {
  addDays,
  daysBetween,
  endOfMonth,
  startOfWeek,
  businessDate,
} from '@/lib/date';
import type {
  CreateExpenseRequest,
  CreateSaleRequest,
  DailyReport,
  DayClose,
  Expense,
  MarginAlert,
  Sale,
  SaleLine,
  SummaryBucket,
  SummaryGranularity,
  SummaryReport,
} from '@/lib/api/types';

import {
  findProductRecord,
  getCurrentMember,
  getMockDb,
  nowIso,
  raiseMarginAlert,
} from './db';
import { badRequest, notFound, conflict, MockHttpError } from './errors';
import { randomCode } from './ids';
import { applyStock } from './stockReceipts';

const sum = <T>(items: T[], pick: (item: T) => number) =>
  items.reduce((total, item) => total + pick(item), 0);

const inRange = (date: string, from?: string | null, to?: string | null) =>
  (!from || date >= from) && (!to || date <= to);

// ---- sales ----------------------------------------------------------------

export function createSale(req: CreateSaleRequest): {
  sale: Sale;
  created: boolean;
} {
  const db = getMockDb();
  const existing = db.sales.find((s) => s.id === req.id);
  if (existing) {
    const hash = db.idempotency.get(`sale:${req.id}`)?.hash;
    if (hash && hash !== JSON.stringify(req))
      throw conflict('id_conflict', 'Sale id reused');
    return { sale: existing, created: false };
  }
  validateSaleCredit(req);

  const lines: SaleLine[] = req.lines.map((line) => {
    let productName: string | null = null;
    let listPrice: number | null = null;
    if (line.product_id) {
      const found = db.products.find((p) => p.product.id === line.product_id);
      if (!found) {
        throw badRequest(
          `product ${line.product_id} does not exist`,
          { product_id: line.product_id },
          'unknown_product',
        );
      }
      const unit = line.unit_id
        ? found.product.units.find((u) => u.id === line.unit_id)
        : undefined;
      if (line.unit_id && !unit) {
        throw badRequest(
          `unit ${line.unit_id} does not belong to the product`,
          { unit_id: line.unit_id },
          'unknown_unit',
        );
      }
      productName = found.product.name ?? null;
      listPrice = unit ? unit.price : found.product.price;
    }
    return {
      ...line,
      line_total: line.unit_price * line.quantity,
      price_mismatch: listPrice !== null && line.unit_price !== listPrice,
      product_name: productName,
    };
  });

  const total = sum(lines, (l) => l.line_total);
  if (total !== req.total) {
    throw badRequest(
      `total ${req.total} does not match the lines (${total})`,
      { expected: total },
      'total_mismatch',
    );
  }
  const creditAmount = req.credit?.amount ?? 0;
  const paid = total - creditAmount;
  const isCash = req.payment_method === 'cash';
  const cashReceived = isCash ? (req.cash_received ?? paid) : null;
  if (cashReceived !== null && cashReceived < paid) {
    throw badRequest(
      'cash_received is less than total',
      { total },
      'cash_short',
    );
  }

  if (req.cash_received !== undefined && req.cash_received < paid)
    throw badRequest('cash_received is less than paid part');

  const code = randomCode(6);
  const at = nowIso();
  const sale: Sale = {
    id: req.id,
    code,
    sold_at: req.sold_at,
    received_at: at,
    business_date: businessDate(req.sold_at),
    member_id: getCurrentMember().id,
    payment_method: req.payment_method,
    credit_amount: creditAmount,
    customer_id: req.credit?.customer_id ?? null,
    cash_received: cashReceived,
    change_given: cashReceived === null ? null : cashReceived - paid,
    total,
    vietqr_memo:
      req.vietqr_memo ??
      (req.payment_method === 'transfer'
        ? `${db.store.sales_memo_prefix ?? 'TH'} ${code}`
        : null),
    status: 'completed',
    void: null,
    lines,
  };
  db.sales.push(sale);
  db.idempotency.set(`sale:${req.id}`, {
    hash: JSON.stringify(req),
    value: sale,
  });
  if (req.credit)
    recordEntry(
      {
        customer_id: req.credit.customer_id,
        amount: creditAmount,
        kind: 'credit_sale',
        sale_id: sale.id,
      },
      req.sold_at,
    );
  for (const line of lines) {
    if (!line.product_id) continue;
    const product = findProductRecord(line.product_id).product;
    if (product.stock_quantity === null) continue;
    const factor =
      product.units.find((u) => u.id === line.unit_id)?.quantity_in_base ?? 1;
    applyStock(product.id, -line.quantity * factor, 'sale', sale.id);
  }
  for (const l of lines) {
    if (l.source !== 'manual') continue;
    db.manualLines.push({
      line_id: l.id,
      sale_id: sale.id,
      sold_at: sale.sold_at,
      sold_by: sale.member_id,
      unit_price: l.unit_price,
      quantity: l.quantity,
      manual_label: l.manual_label ?? null,
      crop_image: null,
      reason: 'manual_price',
      status: 'open',
      resolution: null,
    });
  }
  return { sale, created: true };
}

export function listSales(filters: {
  from?: string | null;
  to?: string | null;
  memberId?: string | null;
  paymentMethod?: string | null;
  status?: string | null;
}): Sale[] {
  return getMockDb()
    .sales.filter((s) => inRange(s.business_date, filters.from, filters.to))
    .filter((s) => !filters.memberId || s.member_id === filters.memberId)
    .filter(
      (s) =>
        !filters.paymentMethod || s.payment_method === filters.paymentMethod,
    )
    .filter((s) => !filters.status || s.status === filters.status)
    .sort(
      (a, b) => b.sold_at.localeCompare(a.sold_at) || b.id.localeCompare(a.id),
    );
}

// ---- expenses -------------------------------------------------------------

export function createExpense(req: CreateExpenseRequest): {
  expense: Expense;
  created: boolean;
} {
  const db = getMockDb();
  const existing = db.expenses.find((e) => e.id === req.id);
  if (existing) return { expense: existing, created: false };

  let image: Expense['image'] = null;
  if (req.image_id) {
    image = db.images.get(req.image_id) ?? null;
    if (!image)
      throw badRequest(
        `image ${req.image_id} does not exist`,
        { image_id: req.image_id },
        'unknown_image',
      );
  }

  const purchases = (req.purchase_lines ?? []).map((line) => {
    const record = findProductRecordOr400(line.product_id);
    const unit = line.unit_id
      ? record.product.units.find((u) => u.id === line.unit_id)
      : undefined;
    if (line.unit_id && !unit) {
      throw badRequest(
        `unit ${line.unit_id} does not belong to the product`,
        { unit_id: line.unit_id },
        'unknown_unit',
      );
    }
    return { line, factor: unit?.quantity_in_base ?? 1 };
  });

  const expenseId = req.id;
  const alerts: MarginAlert[] = [];
  const isLead = getCurrentMember().role === 'lead';
  for (const { line, factor } of purchases) {
    // Only the Lead changes cost price; seller purchases leave it untouched.
    if (!isLead) continue;
    const record = findProductRecord(line.product_id);
    record.product = {
      ...record.product,
      cost_price: Math.round(line.unit_cost / factor),
      version: record.product.version + 1,
      updated_at: nowIso(),
    };
    const alert = raiseMarginAlert(record.product, expenseId);
    if (alert) alerts.push(alert);
  }

  const expense: Expense = {
    ...req,
    business_date: businessDate(req.spent_at),
    member_id: getCurrentMember().id,
    image,
    alerts,
    created_at: nowIso(),
  };
  db.expenses.push(expense);
  return { expense, created: true };
}

function findProductRecordOr400(productId: string) {
  try {
    return findProductRecord(productId);
  } catch {
    throw badRequest(
      `product ${productId} does not exist`,
      { product_id: productId },
      'unknown_product',
    );
  }
}

export function listExpenses(filters: {
  from?: string | null;
  to?: string | null;
  category?: string | null;
}): Expense[] {
  return getMockDb()
    .expenses.filter((e) => inRange(e.business_date, filters.from, filters.to))
    .filter((e) => !filters.category || e.category === filters.category)
    .sort(
      (a, b) =>
        b.spent_at.localeCompare(a.spent_at) || b.id.localeCompare(a.id),
    );
}

// ---- reports and day close ------------------------------------------------

function dayTotals(date: string) {
  const db = getMockDb();
  const sales = db.sales.filter(
    (s) => s.business_date === date && s.status === 'completed',
  );
  const expenses = db.expenses.filter((e) => e.business_date === date);
  const cashSales = sum(
    sales.filter((s) => s.payment_method === 'cash'),
    (s) => s.total - s.credit_amount,
  );
  const transferRevenue = sum(
    sales.filter((s) => s.payment_method === 'transfer'),
    (s) => s.total - s.credit_amount,
  );
  const cashExpenses = sum(
    expenses.filter((e) => e.paid_with === 'cash_box'),
    (e) => e.amount,
  );
  const repayments = db.debtEntries.filter(
    (e) => e.business_date === date && e.kind === 'repayment',
  );
  const cashRepayments = -sum(
    repayments.filter((e) => e.method === 'cash'),
    (e) => e.amount,
  );
  const transferRepayments = -sum(
    repayments.filter((e) => e.method === 'transfer'),
    (e) => e.amount,
  );
  return {
    sales,
    cashRepayments,
    transferRepayments,
    creditSales: sum(sales, (s) => s.credit_amount),
    revenue: sum(sales, (s) => s.total),
    cashSales,
    transferRevenue,
    expenses: sum(expenses, (e) => e.amount),
    cashExpenses,
  };
}

export function getDayClose(date: string): DayClose {
  const close = getMockDb().dayCloses.get(date);
  if (!close) throw notFound('Day close');
  return close;
}

export function getDailyReport(date: string = businessDate()): DailyReport {
  const db = getMockDb();
  const t = dayTotals(date);
  const close = db.dayCloses.get(date) ?? null;
  return {
    business_date: date,
    revenue: t.revenue,
    sales_count: t.sales.length,
    voided_count: db.sales.filter(
      (s) => s.business_date === date && s.status === 'voided',
    ).length,
    cash_revenue: t.cashSales,
    transfer_revenue: t.transferRevenue,
    cash_repayments: t.cashRepayments,
    credit_sales: t.creditSales,
    expenses: t.expenses,
    net: t.revenue - t.expenses,
    expected_cash: Math.max(
      0,
      (close?.opening_float ?? 0) +
        t.cashSales +
        t.cashRepayments -
        t.cashExpenses,
    ),
    manual_lines_open: db.manualLines.filter(
      (l) =>
        l.status === 'open' &&
        db.sales.find((s) => s.id === l.sale_id)?.business_date === date,
    ).length,
    day_close: close,
  };
}

export function putDayClose(
  date: string,
  input: { counted_cash: number; opening_float: number; note: string | null },
): DayClose {
  const t = dayTotals(date);
  const expected = Math.max(
    0,
    input.opening_float + t.cashSales + t.cashRepayments - t.cashExpenses,
  );
  const close: DayClose = {
    business_date: date,
    opening_float: input.opening_float,
    cash_sales: t.cashSales,
    cash_repayments: t.cashRepayments,
    transfer_repayments: t.transferRepayments,
    credit_sales: t.creditSales,
    cash_refunds: 0,
    cash_expenses: t.cashExpenses,
    expected_cash: expected,
    counted_cash: input.counted_cash,
    difference: input.counted_cash - expected,
    transfer_revenue: t.transferRevenue,
    late_sales_count: 0,
    note: input.note,
    closed_by: getCurrentMember().id,
    closed_at: nowIso(),
  };
  getMockDb().dayCloses.set(date, close);
  return close;
}

export function getSummaryReport(
  from: string,
  to: string,
  granularity: SummaryGranularity,
): SummaryReport {
  const span = daysBetween(from, to);
  if (span < 0) throw badRequest('from must not be after to', { from, to });
  if (span > 365)
    throw badRequest('range is limited to 366 days', { from, to });

  const buckets: SummaryBucket[] = [];
  let cursor = from;
  while (cursor <= to) {
    const naturalEnd =
      granularity === 'day'
        ? cursor
        : granularity === 'week'
          ? addDays(startOfWeek(cursor), 6)
          : endOfMonth(cursor);
    const end = naturalEnd < to ? naturalEnd : to;
    buckets.push(bucket(cursor, end));
    cursor = addDays(end, 1);
  }
  return { granularity, buckets };
}

function bucket(start: string, end: string): SummaryBucket {
  const db = getMockDb();
  const sales = db.sales.filter(
    (s) => s.status === 'completed' && inRange(s.business_date, start, end),
  );
  const revenue = sum(sales, (s) => s.total);
  const expenses = sum(
    db.expenses.filter((e) => inRange(e.business_date, start, end)),
    (e) => e.amount,
  );
  return {
    start,
    end,
    revenue,
    expenses,
    net: revenue - expenses,
    sales_count: sales.length,
  };
}

export function voidSale(id: string, body: Record<string, unknown>): Sale {
  const sale = getMockDb().sales.find((s) => s.id === id);
  if (!sale) throw notFound('Sale');
  const member = getCurrentMember();
  if (
    member.role !== 'lead' &&
    (sale.member_id !== member.id || sale.business_date !== businessDate())
  )
    throw new MockHttpError(403, 'forbidden', 'Cannot void this sale');
  if (sale.status === 'voided') return sale;
  if (typeof body.reason !== 'string' || !body.reason.trim())
    throw badRequest('reason required');
  // The server stamps the void with its own time and ignores a client voided_at.
  const at = nowIso();
  sale.status = 'voided';
  sale.void = {
    reason: body.reason,
    voided_by: getCurrentMember().id,
    voided_at: at,
  };
  reverseSaleCredit(sale, at);
  for (const line of sale.lines) {
    if (!line.product_id) continue;
    const product = findProductRecord(line.product_id).product;
    if (product.stock_quantity === null) continue;
    const factor =
      product.units.find((u) => u.id === line.unit_id)?.quantity_in_base ?? 1;
    applyStock(product.id, line.quantity * factor, 'sale_void', sale.id);
  }
  return sale;
}
