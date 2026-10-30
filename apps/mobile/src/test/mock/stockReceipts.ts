import { newUuid } from '@/lib/uuid';
import type {
  Product,
  Receipt,
  ReceiptConfirm,
  ReceiptLine,
  ReceiptSummary,
  StockAdjustment,
  StockItem,
  StockMovement,
} from '@/lib/api/types';

import { findProductRecord, getCurrentMember, getMockDb, nowIso } from './db';
import { conflict, notFound, unprocessableEntity } from './errors';
import { PRODUCT_IDS } from './fixtures';
import { createExpense } from './ledger';
import { isMoney, isUuid } from './validate';
import { emitMockEvent } from './events';

export function stockStatus(product: Product): StockItem['status'] {
  const n = product.stock_quantity;
  return n == null
    ? 'untracked'
    : n <= 0
      ? 'out'
      : n <=
          (product.low_stock_threshold ?? getMockDb().store.low_stock_threshold)
        ? 'low'
        : 'ok';
}

export function listStock(status = 'all'): StockItem[] {
  if (!['all', 'low', 'out'].includes(status))
    throw unprocessableEntity('Invalid stock status');
  const rank = { out: 0, low: 1, ok: 2, untracked: 3 };
  return getMockDb()
    .products.filter(({ product }) => !product.archived)
    .map(({ product: p }): StockItem => ({
      product_id: p.id,
      name: p.name ?? null,
      image_url: p.images[0]?.url ?? null,
      stock_quantity: p.stock_quantity,
      low_stock_threshold:
        p.low_stock_threshold ?? getMockDb().store.low_stock_threshold,
      status: stockStatus(p),
      updated_at: p.updated_at,
    }))
    .filter((p) =>
      status === 'all' ? p.status !== 'untracked' : p.status === status,
    )
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.name ?? '').localeCompare(b.name ?? ''),
    );
}

export function applyStock(
  productId: string,
  delta: number,
  reason: StockMovement['reason'],
  refId: string | null = null,
  note: string | null = null,
): StockMovement {
  const db = getMockDb();
  const record = findProductRecord(productId);
  const before = record.product.stock_quantity;
  const threshold =
    record.product.low_stock_threshold ?? db.store.low_stock_threshold;
  const after = (before ?? 0) + delta;
  record.product = {
    ...record.product,
    stock_quantity: after,
    updated_at: nowIso(),
    version: record.product.version + 1,
  };
  record.product.stock_status = stockStatus(record.product);
  const movement: StockMovement = {
    id: newUuid(),
    delta,
    quantity_after: after,
    reason,
    ref_id: refId,
    member_id: getCurrentMember().id,
    note,
    created_at: nowIso(),
  };
  db.stockMovements.set(productId, [
    movement,
    ...(db.stockMovements.get(productId) ?? []),
  ]);
  emitMockEvent({
    type: 'stock.changed',
    occurred_at: movement.created_at,
    data: { product_id: productId, stock_quantity: after, reason },
  });
  if (before !== null && before > threshold && after <= threshold)
    emitMockEvent({
      type: 'stock.low',
      occurred_at: movement.created_at,
      data: {
        product_id: productId,
        name: record.product.name ?? null,
        stock_quantity: after,
        threshold,
      },
    });
  return movement;
}

export function adjustStock(
  productId: string,
  input: StockAdjustment,
): StockMovement {
  const product = findProductRecord(productId).product;
  if (
    (input.count === undefined) === (input.delta === undefined) ||
    (input.count !== undefined &&
      (!Number.isSafeInteger(input.count) || input.count < 0)) ||
    (input.delta !== undefined &&
      (!Number.isSafeInteger(input.delta) || input.delta === 0)) ||
    (input.note !== undefined &&
      (typeof input.note !== 'string' || input.note.length > 200))
  ) {
    throw unprocessableEntity(
      'Provide exactly one valid count or nonzero delta and a note up to 200 characters',
    );
  }
  return applyStock(
    productId,
    input.count === undefined
      ? input.delta!
      : input.count - (product.stock_quantity ?? 0),
    'adjustment',
    null,
    input.note ?? null,
  );
}

export function listStockMovements(productId: string): StockMovement[] {
  findProductRecord(productId);
  return getMockDb().stockMovements.get(productId) ?? [];
}

export function getReceipt(id: string): Receipt {
  const receipt = getMockDb().receipts.find((r) => r.id === id);
  if (!receipt) throw notFound('Receipt');
  return receipt;
}

export function createReceipt(imageId: unknown): Receipt {
  const db = getMockDb();
  const image =
    typeof imageId === 'string' ? db.images.get(imageId) : undefined;
  if (!image) throw notFound('Image');
  const seeds: [string, number, number, string | null][] = [
    ['Coca-Cola lon 330ml', 24, 204000, PRODUCT_IDS.coca!],
    ['Mì Hảo Hảo tôm chua cay', 30, 126000, PRODUCT_IDS.haohao!],
    ['Nước suối Aquafina 500ml', 12, 60000, PRODUCT_IDS.aquafina!],
    ['Bánh Chocopie hộp', 5, 66000, null],
  ];
  const lines = seeds.map(
    ([product_name, quantity, cost, product_id], position): ReceiptLine => ({
      id: newUuid(),
      position,
      product_name,
      quantity,
      cost,
      product_id,
      raw_text: `${product_name} x${quantity} ${cost}`,
      match_confidence: product_id ? 0.91 : null,
      candidates: (product_id
        ? [product_id]
        : [PRODUCT_IDS.oreo!, PRODUCT_IDS.omachi!]
      ).map((id, i) => ({
        product_id: id,
        name: findProductRecord(id).product.name ?? null,
        probability: product_id ? 0.91 : 0.45 - i * 0.1,
      })),
    }),
  );
  const receipt: Receipt = {
    id: newUuid(),
    image_id: image.id,
    image_url: image.url,
    status: 'draft',
    total: 456000,
    parser: 'decisions',
    model: 'inception/mercury-decide:free',
    lines,
    timings: { ocr: 1840, parse: 12, decisions: 620, total: 2472 },
    expense_id: null,
    created_at: nowIso(),
    confirmed_at: null,
  };
  db.receipts.unshift(receipt);
  return receipt;
}

export function listReceipts(status: string | null): ReceiptSummary[] {
  if (status && !['draft', 'confirmed', 'discarded'].includes(status))
    throw unprocessableEntity('Invalid receipt status');
  return getMockDb()
    .receipts.filter((r) => !status || r.status === status)
    .map((r) => ({
      id: r.id,
      status: r.status,
      total: r.total,
      line_count: r.lines.length,
      matched_count: r.lines.filter((l) => l.product_id !== null).length,
      image_url: r.image_url,
      created_at: r.created_at,
      confirmed_at: r.confirmed_at,
      expense_id: r.expense_id,
    }));
}

export function confirmReceipt(id: string, body: ReceiptConfirm): Receipt {
  const receipt = getReceipt(id);
  if (receipt.status !== 'draft')
    throw conflict('already_confirmed', 'Receipt is no longer a draft');
  if (
    !Array.isArray(body.lines) ||
    body.lines.length < 1 ||
    body.lines.length > 100 ||
    !['cash_box', 'other'].includes(body.paid_with) ||
    (body.spent_at !== undefined &&
      (typeof body.spent_at !== 'string' ||
        !/^\d{4}-\d\d-\d\dT/.test(body.spent_at) ||
        !Number.isFinite(Date.parse(body.spent_at))))
  ) {
    throw unprocessableEntity('Invalid receipt lines, payment or date');
  }
  const lines = body.lines.map((line, position): ReceiptLine => {
    if (
      !line ||
      !isUuid(line.product_id) ||
      !getMockDb().products.some((r) => r.product.id === line.product_id) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !isMoney(line.cost) ||
      (line.line_id !== undefined &&
        !receipt.lines.some((l) => l.id === line.line_id))
    )
      throw unprocessableEntity('Invalid receipt line');
    const original = receipt.lines.find((l) => l.id === line.line_id);
    return {
      id: original?.id ?? newUuid(),
      position,
      raw_text: original?.raw_text ?? '',
      product_name:
        original?.product_name ??
        findProductRecord(line.product_id).product.name ??
        '',
      quantity: line.quantity,
      cost: line.cost,
      product_id: line.product_id,
      match_confidence: original?.match_confidence ?? null,
      candidates: original?.candidates ?? [],
    };
  });
  const total = lines.reduce((sum, l) => sum + l.cost, 0);
  if (total <= 0) throw unprocessableEntity('Receipt total must be positive');
  const expense = createExpense({
    id: newUuid(),
    spent_at: body.spent_at ?? nowIso(),
    amount: total,
    category: 'nhap_hang',
    paid_with: body.paid_with,
    image_id: receipt.image_id,
    purchase_lines: lines.map((l) => ({
      product_id: l.product_id!,
      quantity: l.quantity,
      unit_cost: Math.ceil(l.cost / l.quantity),
    })),
  }).expense;
  for (const line of lines)
    applyStock(line.product_id!, line.quantity, 'receipt', id);
  const next: Receipt = {
    ...receipt,
    status: 'confirmed',
    lines,
    total,
    expense_id: expense.id,
    confirmed_at: nowIso(),
  };
  getMockDb().receipts = getMockDb().receipts.map((r) =>
    r.id === id ? next : r,
  );
  emitMockEvent({
    type: 'receipt.confirmed',
    occurred_at: next.confirmed_at!,
    data: {
      receipt_id: id,
      expense_id: expense.id,
      total,
      line_count: lines.length,
    },
  });
  return next;
}

export function discardReceipt(id: string): void {
  const receipt = getReceipt(id);
  if (receipt.status !== 'draft')
    throw conflict('already_confirmed', 'Only drafts can be discarded');
  receipt.status = 'discarded';
}

/** Endpoint-scoped keys replay the first result and reject a changed request body. */
export function idempotent<T>(
  scope: string,
  request: Request,
  body: unknown,
  action: () => T,
): T {
  const key = request.headers.get('Idempotency-Key');
  if (!key) throw unprocessableEntity('Idempotency-Key is required');
  const db = getMockDb();
  const cacheKey = `${scope}:${key}`;
  const hash = JSON.stringify(body);
  const previous = db.idempotency.get(cacheKey);
  if (previous) {
    if (previous.hash !== hash)
      throw conflict('id_conflict', 'Idempotency key reused with another body');
    return previous.value as T;
  }
  const value = action();
  db.idempotency.set(cacheKey, { hash, value });
  return value;
}
