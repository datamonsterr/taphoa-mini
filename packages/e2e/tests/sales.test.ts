import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertErrorResponse,
  createStore,
  joinAsSeller,
  uniqueName,
  type CreatedStore,
  type JoinedSeller,
} from '../src/helpers.js';
import type { ApiClient, components } from '@taphoa/api-client';

type CreateSaleRequest = components['schemas']['CreateSaleRequest'];
type CreateExpenseRequest = components['schemas']['CreateExpenseRequest'];
type Expense = components['schemas']['Expense'];
type ManualLine = components['schemas']['ManualLine'];
type Sale = components['schemas']['Sale'];

/**
 * Money flow specs (E4). Catalog access is kept out: every sale line here is
 * `source: 'manual'` with `product_id: null`, and the two cases that enroll
 * products skip unless POST /v1/products (owned by the catalog epic) exists.
 */

/** Client UUIDv7 as POST /v1/sales requires; default randomness only provides v4. */
function uuid7(): string {
  const buffer = Buffer.alloc(16);
  const milliseconds = Date.now();
  buffer.writeUint32BE(Math.floor(milliseconds / 2 ** 16), 0);
  buffer.writeUint16BE(milliseconds & 0xffff, 4);
  randomBytes(10).copy(buffer, 6);
  buffer[6] = (buffer[6] & 0x0f) | 0x70;
  buffer[8] = (buffer[8] & 0x3f) | 0x80;
  const hex = buffer.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

interface ManualSaleOverrides {
  payment_method?: 'cash' | 'transfer';
  cash_received?: number;
  unit_price?: number;
  manual_label?: string;
}

function manualSaleBody(overrides?: ManualSaleOverrides): CreateSaleRequest {
  const unitPrice = overrides?.unit_price ?? 7000;
  const paymentMethod = overrides?.payment_method ?? 'cash';
  return {
    id: uuid7(),
    sold_at: new Date().toISOString(),
    payment_method: paymentMethod,
    ...(paymentMethod === 'cash'
      ? { cash_received: overrides?.cash_received ?? unitPrice }
      : {}),
    total: unitPrice,
    lines: [
      {
        id: uuid7(),
        product_id: null,
        source: 'manual',
        quantity: 1,
        unit_price: unitPrice,
        manual_label: overrides?.manual_label ?? 'Khác',
      },
    ],
  };
}

interface SaleResult {
  status: number;
  sale?: Sale | undefined;
  error: unknown;
}

// The endpoint returns the same Sale schema for both 201 and the 200 replay.
async function postSale(
  client: ApiClient,
  body: CreateSaleRequest,
): Promise<SaleResult> {
  const { data, error, response } = await client.raw.POST('/v1/sales', {
    body,
  });
  return { status: response.status, sale: data, error };
}

async function createSale(
  client: ApiClient,
  overrides?: ManualSaleOverrides,
): Promise<{ body: CreateSaleRequest; sale: Sale }> {
  const body = manualSaleBody(overrides);
  const result = await postSale(client, body);
  expect(result.status).toBe(201);
  expect(result.error).toBeUndefined();
  expect(result.sale).toBeDefined();
  return { body, sale: result.sale! };
}

async function createExpense(
  client: ApiClient,
  fields: {
    amount: number;
    category: CreateExpenseRequest['category'];
    paid_with: CreateExpenseRequest['paid_with'];
    note?: string;
  },
): Promise<{ body: CreateExpenseRequest; expense: Expense }> {
  const body: CreateExpenseRequest = {
    id: uuid7(),
    spent_at: new Date().toISOString(),
    amount: fields.amount,
    category: fields.category,
    paid_with: fields.paid_with,
    ...(fields.note ? { note: fields.note } : {}),
  };
  const { data, error, response } = await client.raw.POST('/v1/expenses', {
    body,
  });
  expect(response.status).toBe(201);
  expect(error).toBeUndefined();
  return { body, expense: data! };
}

/**
 * Seeds a store with a known money record set: two cash sales (20000, 15000),
 * one transfer sale (12000), an 8000 electricity expense paid from the cash box
 * and a 4000 purchase paid "other". Returns the business date covered by them.
 */
async function seedMoneyStore(): Promise<{
  lead: CreatedStore;
  seller: JoinedSeller;
  businessDate: string;
  sales: { body: CreateSaleRequest; sale: Sale }[];
  expenses: { body: CreateExpenseRequest; expense: Expense }[];
}> {
  const lead = await createStore();
  const seller = await joinAsSeller(lead.client);
  const sales = [
    await createSale(seller.client, {
      unit_price: 20_000,
      cash_received: 50_000,
      manual_label: 'Phao keo',
    }),
    await createSale(seller.client, { unit_price: 15_000 }),
    await createSale(lead.client, {
      payment_method: 'transfer',
      unit_price: 12_000,
    }),
  ];
  const expenses = [
    await createExpense(seller.client, {
      amount: 8_000,
      category: 'dien',
      paid_with: 'cash_box',
      note: 'Tien dien',
    }),
    await createExpense(seller.client, {
      amount: 4_000,
      category: 'khac',
      paid_with: 'other',
      note: 'Phi ve sinh',
    }),
  ];
  return {
    lead,
    seller,
    businessDate: sales[0].sale.business_date,
    sales,
    expenses,
  };
}

/**
 * Probes whether the catalog epic (POST /v1/products) is deployed; 404/405
 * mean the route is missing so catalog-dependent cases must skip.
 */
async function probeCatalogAvailable(): Promise<boolean> {
  try {
    const { client } = await createStore();
    const probe = await client.raw.POST('/v1/products', {
      body: {} as never as components['schemas']['CreateProductRequest'],
    });
    const status = probe.response.status;
    return status !== 404 && status !== 405;
  } catch {
    return false;
  }
}

const catalogAvailable = await probeCatalogAvailable();

/** Minimal valid 1x1 PNG for catalog reference images. */
function onePixelPng(): Blob {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new Blob([bytes], { type: 'image/png' });
}

describe('Sales & Money Flows (E4)', () => {
  describe('POST /v1/sales: manual cash line', () => {
    it('records with 201 and change_given 3000, replays an identical body with 200, rejects a reused id with 409 and a wrong total with 400', async () => {
      const { client: leadClient } = await createStore();
      const { session: sellerSession, client: sellerClient } =
        await joinAsSeller(leadClient);

      const body = manualSaleBody({
        manual_label: `Chai nuoc la ${uniqueName('n')}`,
        cash_received: 10_000,
      });
      const created = await postSale(sellerClient, body);
      expect(created.status).toBe(201);
      expect(created.error).toBeUndefined();
      const sale = created.sale!;
      expect(sale.id).toBe(body.id);
      expect(sale.code).toMatch(/^[0-9A-Z]{6}$/);
      expect(sale.status).toBe('completed');
      expect(sale.member_id).toBe(sellerSession.member.id);
      expect(sale.payment_method).toBe('cash');
      expect(sale.total).toBe(7000);
      expect(sale.cash_received).toBe(10_000);
      expect(sale.change_given).toBe(3000);
      expect(typeof sale.sold_at).toBe('string');
      expect(typeof sale.received_at).toBe('string');
      expect(typeof sale.business_date).toBe('string');
      expect(sale.vietqr_memo).toBeNull();
      expect(sale.void).toBeNull();

      expect(sale.lines.length).toBe(1);
      const [line] = sale.lines;
      expect(line.id).toBe(body.lines[0].id);
      expect(line.product_id).toBeNull();
      expect(line.source).toBe('manual');
      expect(line.quantity).toBe(1);
      expect(line.unit_price).toBe(7000);
      expect(line.line_total).toBe(7000);
      expect(line.price_mismatch).toBe(false);
      expect(line.product_name).toBeNull();
      expect(line.manual_label).toBe(body.lines[0].manual_label);
      expect(line.unit_id).toBeNull();
      expect(line.detection_id).toBeNull();
      expect(line.suggested_product_id).toBeNull();

      // Outbox-style replay with the identical body => 200, same stored sale.
      const replay = await postSale(sellerClient, body);
      expect(replay.status).toBe(200);
      expect(replay.sale!.id).toBe(sale.id);
      expect(replay.sale!.received_at).toBe(sale.received_at);

      // The same client id with any different request => 409 id_conflict.
      const conflicting: CreateSaleRequest = { ...body, cash_received: 11_000 };
      const conflict = await postSale(sellerClient, conflicting);
      expect(conflict.status).toBe(409);
      assertErrorResponse(conflict.error, 'id_conflict');

      // The server never reprices: recompute and reject a mismatched total.
      const wrongTotal: CreateSaleRequest = {
        ...body,
        id: uuid7(),
        total: 7500,
      };
      const mismatch = await postSale(sellerClient, wrongTotal);
      expect(mismatch.status).toBe(400);
      assertErrorResponse(mismatch.error, 'total_mismatch');
    });
  });

  describe('manual-line review queue', () => {
    it('shows the flagged line to the lead (reason manual_price), 403 for the seller, and dismisses it', async () => {
      const { client: leadClient, session: leadSession } = await createStore();
      const { session: sellerSession, client: sellerClient } =
        await joinAsSeller(leadClient);

      const seeded = await createSale(sellerClient, {
        manual_label: 'Go bun',
      });
      const lineId = seeded.sale.lines[0].id;

      const asSeller = await sellerClient.raw.GET('/v1/review/manual-lines');
      expect(asSeller.response.status).toBe(403);
      assertErrorResponse(asSeller.error);

      const openPage = await leadClient.raw.GET('/v1/review/manual-lines', {
        params: { query: { status: 'open' } },
      });
      expect(openPage.response.status).toBe(200);
      expect(openPage.error).toBeUndefined();
      const flagged = openPage.data!.items.find(
        (line) => line.line_id === lineId,
      );
      expect(flagged).toBeDefined();
      expect(flagged!.sale_id).toBe(seeded.sale.id);
      expect(flagged!.reason).toBe('manual_price');
      expect(flagged!.status).toBe('open');
      expect(flagged!.sold_by).toBe(sellerSession.member.id);
      expect(flagged!.unit_price).toBe(7000);
      expect(flagged!.quantity).toBe(1);
      expect(flagged!.manual_label).toBe('Go bun');
      expect(flagged!.resolution).toBeNull();
      expect(flagged!.crop_image).toBeNull();

      const resolved = await leadClient.raw.POST(
        '/v1/review/manual-lines/{lineId}/resolve',
        {
          params: { path: { lineId } },
          body: { action: 'dismiss' },
        },
      );
      expect(resolved.response.status).toBe(200);
      expect(resolved.error).toBeUndefined();
      expect(resolved.data!.status).toBe('resolved');
      expect(resolved.data!.line_id).toBe(lineId);
      expect(resolved.data!.resolution!.action).toBe('dismiss');
      expect(resolved.data!.resolution!.product_id).toBeNull();
      expect(resolved.data!.resolution!.resolved_by).toBe(
        leadSession.member.id,
      );

      const openAfter = await leadClient.raw.GET('/v1/review/manual-lines', {
        params: { query: { status: 'open' } },
      });
      expect(
        openAfter.data!.items.some((line) => line.line_id === lineId),
      ).toBe(false);
      const resolvedPage = await leadClient.raw.GET('/v1/review/manual-lines', {
        params: { query: { status: 'resolved' } },
      });
      expect(
        resolvedPage.data!.items.some((line) => line.line_id === lineId),
      ).toBe(true);
    });
  });

  describe('voiding sales', () => {
    it('lets a seller void their own same-day sale and blocks voiding the lead sale', async () => {
      const { client: leadClient, session: leadSession } = await createStore();
      const { session: sellerSession, client: sellerClient } =
        await joinAsSeller(leadClient);

      const own = await createSale(sellerClient);
      const leadSale = await createSale(leadClient, {
        payment_method: 'transfer',
        unit_price: 9000,
      });
      expect(leadSession.member.id).not.toBe(sellerSession.member.id);

      const voided = await sellerClient.raw.POST('/v1/sales/{saleId}/void', {
        params: { path: { saleId: own.body.id } },
        body: { reason: 'Ban nham chinh tien' },
      });
      expect(voided.response.status).toBe(200);
      expect(voided.error).toBeUndefined();
      expect(voided.data!.status).toBe('voided');
      expect(voided.data!.id).toBe(own.body.id);
      expect(voided.data!.void!.reason).toBe('Ban nham chinh tien');
      expect(voided.data!.void!.voided_by).toBe(sellerSession.member.id);
      expect(typeof voided.data!.void!.voided_at).toBe('string');

      const blocked = await sellerClient.raw.POST('/v1/sales/{saleId}/void', {
        params: { path: { saleId: leadSale.body.id } },
        body: { reason: 'Not my sale' },
      });
      expect(blocked.response.status).toBe(403);
      assertErrorResponse(blocked.error);

      const detail = await sellerClient.raw.GET('/v1/sales/{saleId}', {
        params: { path: { saleId: leadSale.body.id } },
      });
      expect(detail.response.status).toBe(200);
      expect(detail.data!.status).toBe('completed');
    });
  });

  describe('expenses', () => {
    it('records a cash-box expense with 201, replays with 200, allows the lead to patch and delete, and blocks the seller delete', async () => {
      const { client: leadClient } = await createStore();
      const { session: sellerSession, client: sellerClient } =
        await joinAsSeller(leadClient);

      const created = await createExpense(sellerClient, {
        amount: 12_000,
        category: 'dien',
        paid_with: 'cash_box',
        note: 'Tien dien thang nay',
      });
      const { body, expense } = created;
      expect(expense.id).toBe(body.id);
      expect(expense.amount).toBe(12_000);
      expect(expense.category).toBe('dien');
      expect(expense.paid_with).toBe('cash_box');
      expect(expense.note).toBe('Tien dien thang nay');
      expect(expense.member_id).toBe(sellerSession.member.id);
      expect(typeof expense.business_date).toBe('string');
      expect(typeof expense.created_at).toBe('string');
      expect(expense.purchase_lines).toEqual([]);
      expect(expense.alerts).toEqual([]);

      const replay = await sellerClient.raw.POST('/v1/expenses', { body });
      expect(replay.response.status).toBe(200);
      expect(replay.data!.id).toBe(expense.id);

      const patched = await leadClient.raw.PATCH('/v1/expenses/{expenseId}', {
        params: { path: { expenseId: expense.id } },
        headers: { 'content-type': 'application/merge-patch+json' },
        body: { note: 'Tien dien da kiem' },
      });
      expect(patched.response.status).toBe(200);
      expect(patched.data!.id).toBe(expense.id);
      expect(patched.data!.note).toBe('Tien dien da kiem');
      expect(patched.data!.amount).toBe(12_000);
      expect(patched.data!.category).toBe('dien');

      const deletedBySeller = await sellerClient.raw.DELETE(
        '/v1/expenses/{expenseId}',
        { params: { path: { expenseId: expense.id } } },
      );
      expect(deletedBySeller.response.status).toBe(403);
      assertErrorResponse(deletedBySeller.error);

      const deleted = await leadClient.raw.DELETE('/v1/expenses/{expenseId}', {
        params: { path: { expenseId: expense.id } },
      });
      expect(deleted.response.status).toBe(204);

      const gone = await leadClient.raw.GET('/v1/expenses/{expenseId}', {
        params: { path: { expenseId: expense.id } },
      });
      expect(gone.response.status).toBe(404);
    });
  });

  describe('money reports', () => {
    it('today reflects revenue/expenses/net/expected_cash with exact numbers, summary buckets the day, and reports/recognition stays lead-only', async () => {
      const seeded = await seedMoneyStore();

      const today = await seeded.lead.client.raw.GET('/v1/reports/today', {
        params: { query: { date: seeded.businessDate } },
      });
      expect(today.response.status).toBe(200);
      expect(today.error).toBeUndefined();
      expect(today.data!.business_date).toBe(seeded.businessDate);
      expect(today.data!.revenue).toBe(47_000);
      expect(today.data!.sales_count).toBe(3);
      expect(today.data!.voided_count).toBe(0);
      expect(today.data!.cash_revenue).toBe(35_000);
      expect(today.data!.transfer_revenue).toBe(12_000);
      expect(today.data!.expenses).toBe(12_000);
      expect(today.data!.net).toBe(35_000);
      expect(today.data!.expected_cash).toBe(27_000);
      expect(today.data!.manual_lines_open).toBe(3);
      expect(today.data!.day_close).toBeNull();

      const summary = await seeded.lead.client.raw.GET('/v1/reports/summary', {
        params: {
          query: { from: seeded.businessDate, to: seeded.businessDate },
        },
      });
      expect(summary.response.status).toBe(200);
      expect(summary.error).toBeUndefined();
      expect(summary.data!.granularity).toBe('day');
      expect(summary.data!.buckets.length).toBe(1);
      const bucket = summary.data!.buckets[0];
      expect(bucket.start).toBe(seeded.businessDate);
      expect(bucket.end).toBe(seeded.businessDate);
      expect(bucket.revenue).toBe(47_000);
      expect(bucket.expenses).toBe(12_000);
      expect(bucket.net).toBe(35_000);
      expect(bucket.sales_count).toBe(3);

      const topProducts = await seeded.lead.client.raw.GET(
        '/v1/reports/top-products',
        {
          params: {
            query: { from: seeded.businessDate, to: seeded.businessDate },
          },
        },
      );
      expect(topProducts.response.status).toBe(200);
      expect(topProducts.error).toBeUndefined();
      // Everything is sold without a catalog match, so no product ranks.
      expect(topProducts.data!.items).toEqual([]);

      const recognitionAsSeller = await seeded.seller.client.raw.GET(
        '/v1/reports/recognition',
        {
          params: {
            query: { from: seeded.businessDate, to: seeded.businessDate },
          },
        },
      );
      expect(recognitionAsSeller.response.status).toBe(403);
      assertErrorResponse(recognitionAsSeller.error);

      const recognition = await seeded.lead.client.raw.GET(
        '/v1/reports/recognition',
        {
          params: {
            query: { from: seeded.businessDate, to: seeded.businessDate },
          },
        },
      );
      expect(recognition.response.status).toBe(200);
      expect(recognition.error).toBeUndefined();
      expect(typeof recognition.data!.detections).toBe('number');
      expect(typeof recognition.data!.confirmed_top1).toBe('number');
      expect(typeof recognition.data!.confirmed_top3).toBe('number');
      expect(typeof recognition.data!.corrected).toBe('number');
      expect(typeof recognition.data!.unknown).toBe('number');
    });
  });

  describe('day close', () => {
    it('computes expected_cash and difference exactly, persists them for GET, and blocks the seller', async () => {
      const { lead, seller, businessDate } = await seedMoneyStore();

      const countedCash = 63_000;
      const openingFloat = 50_000;
      const put = await lead.client.raw.PUT('/v1/day-closes/{businessDate}', {
        params: { path: { businessDate } },
        body: { counted_cash: countedCash, opening_float: openingFloat },
      });
      expect(put.response.status).toBe(200);
      expect(put.error).toBeUndefined();
      // expected_cash = 50000 opening + 35000 cash sales - 8000 cash expenses.
      const expectedCash = openingFloat + 35_000 - 8_000;
      expect(put.data!.business_date).toBe(businessDate);
      expect(put.data!.opening_float).toBe(openingFloat);
      expect(put.data!.cash_sales).toBe(35_000);
      expect(put.data!.cash_refunds).toBe(0);
      expect(put.data!.cash_expenses).toBe(8_000);
      expect(put.data!.expected_cash).toBe(expectedCash);
      expect(put.data!.counted_cash).toBe(countedCash);
      expect(put.data!.difference).toBe(countedCash - expectedCash);
      expect(put.data!.transfer_revenue).toBe(12_000);
      expect(put.data!.closed_by).toBe(lead.session.member.id);
      expect(typeof put.data!.closed_at).toBe('string');

      const asSeller = await seller.client.raw.PUT(
        '/v1/day-closes/{businessDate}',
        {
          params: { path: { businessDate } },
          body: { counted_cash: 0 },
        },
      );
      expect(asSeller.response.status).toBe(403);
      assertErrorResponse(asSeller.error);

      const fetched = await lead.client.raw.GET(
        '/v1/day-closes/{businessDate}',
        {
          params: { path: { businessDate } },
        },
      );
      expect(fetched.response.status).toBe(200);
      expect(fetched.error).toBeUndefined();
      expect(fetched.data!.business_date).toBe(businessDate);
      expect(fetched.data!.expected_cash).toBe(expectedCash);
      expect(fetched.data!.counted_cash).toBe(countedCash);
      expect(fetched.data!.difference).toBe(countedCash - expectedCash);
      expect(fetched.data!.closed_by).toBe(lead.session.member.id);

      const listed = await lead.client.raw.GET('/v1/day-closes');
      expect(listed.response.status).toBe(200);
      expect(
        listed.data!.items.some((row) => row.business_date === businessDate),
      ).toBe(true);
    });
  });

  describe('transaction export', () => {
    it("exports the day's transactions as CSV containing the sale code for the lead and blocks the seller", async () => {
      const { lead, seller, businessDate, sales } = await seedMoneyStore();
      const code = sales[0].sale.code;

      const exportRes = await lead.client.raw.GET('/v1/exports/transactions', {
        params: {
          query: { from: businessDate, to: businessDate, format: 'csv' },
        },
        parseAs: 'text',
      });
      expect(exportRes.response.status).toBe(200);
      expect(exportRes.error).toBeUndefined();
      expect(exportRes.response.headers.get('content-type')).toMatch(
        /^text\/csv/,
      );
      expect(exportRes.response.headers.get('content-disposition')).toContain(
        '.csv',
      );
      const csv = String(exportRes.data).replace(/^\uFEFF/, '');
      expect(csv).toContain('type,business_date,time,code_or_category');
      expect(csv).toContain(`,${code},`);
      expect(csv).toMatch(/(^|\n)sale,/);
      expect(csv).toMatch(/(^|\n)expense,/);
      expect(csv).toContain(',dien,');

      const blocked = await seller.client.raw.GET('/v1/exports/transactions', {
        params: {
          query: { from: businessDate, to: businessDate, format: 'csv' },
        },
        parseAs: 'text',
      });
      expect(blocked.response.status).toBe(403);
      assertErrorResponse(blocked.error);
    });
  });

  describe('purchases & margin alerts (requires the catalog epic)', () => {
    it.skipIf(!catalogAvailable)(
      'a purchase that leaves margin below the threshold raises an alert and accepting it reprices the product',
      async () => {
        const { client: leadClient } = await createStore();

        const patched = await leadClient.raw.PATCH('/v1/store', {
          headers: { 'content-type': 'application/merge-patch+json' },
          body: { margin_threshold_pct: 10 },
        });
        expect(patched.response.status).toBe(200);
        expect(patched.data!.margin_threshold_pct).toBe(10);

        const upload = await leadClient.uploadImage(
          onePixelPng(),
          'enrollment',
        );
        expect(upload.response.status).toBe(201);
        const imageId = upload.data!.id;

        const productId = uuid7();
        const product = await leadClient.raw.POST('/v1/products', {
          body: {
            id: productId,
            price: 9000,
            cost_price: 8500,
            image_ids: [imageId],
            name: `Mi tom ${uniqueName('mip')}`,
            force_new: false,
          },
        });
        expect(product.response.status).toBe(201);
        expect(product.data!.price).toBe(9000);
        expect(product.data!.cost_price).toBe(8500);

        // 8500 cost against the 9000 price is a ~5.6% margin, below the 10% threshold.
        const { expense } = await createExpense(leadClient, {
          amount: 8500,
          category: 'nhap_hang',
          paid_with: 'cash_box',
          note: 'Nhap chua thung dau tien',
        });
        expect(expense.purchase_lines!.length).toBe(1);
        const purchaseLine = expense.purchase_lines![0];
        expect(purchaseLine.product_id).toBe(productId);
        expect(purchaseLine.quantity).toBe(1);
        expect(purchaseLine.unit_cost).toBe(8500);

        expect(expense.alerts!.length).toBe(1);
        const alert = expense.alerts![0];
        expect(alert.product_id).toBe(productId);
        expect(alert.cost_price).toBe(8500);
        expect(alert.selling_price).toBe(9000);
        expect(alert.status).toBe('open');
        expect(alert.suggested_price).toBe(10_000);
        expect(alert.margin_pct).toBeCloseTo(5.56, 2);
        expect(alert.expense_id).toBe(expense.id);

        const accepted = await leadClient.raw.POST(
          '/v1/alerts/{alertId}/accept',
          { params: { path: { alertId: alert.id } } },
        );
        expect(accepted.response.status).toBe(200);
        expect(accepted.data!.status).toBe('accepted');
        expect(accepted.data!.suggested_price).toBe(10_000);

        const detail = await leadClient.raw.GET('/v1/products/{productId}', {
          params: { path: { productId } },
        });
        expect(detail.response.status).toBe(200);
        expect(detail.data!.price).toBe(10_000);
      },
    );
  });
});
