import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertErrorResponse,
  createStore,
  joinAsSeller,
  uniqueName,
} from '../src/helpers.js';
import { uuid7 } from '../src/stock-fixtures.js';
import type { ApiClient, components } from '@taphoa/api-client';

type Customer = components['schemas']['Customer'];
type DebtEntry = components['schemas']['DebtEntry'];
type DebtSummary = components['schemas']['DebtSummary'];
type DayClose = components['schemas']['DayClose'];
type CreateCustomerRequest = components['schemas']['CreateCustomerRequest'];
type CreateSaleRequest = components['schemas']['CreateSaleRequest'];
type Sale = components['schemas']['Sale'];

/**
 * Debt book (X5). Every test owns its store. Sale lines are `source: 'manual'` so the specs
 * need no catalog, models or storage; they only exercise the money and debt rules.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const CUSTOMER_KEYS = [
  'id',
  'name',
  'phone',
  'note',
  'credit_limit',
  'balance',
  'oldest_debt_date',
  'debt_age_days',
  'overdue',
  'archived',
  'created_at',
  'updated_at',
];
const ENTRY_KEYS = [
  'id',
  'customer_id',
  'kind',
  'amount',
  'balance_after',
  'sale_id',
  'method',
  'reason',
  'member_id',
  'business_date',
  'created_at',
];

function expectNullOr(value: unknown, type: 'string' | 'number') {
  if (value !== null) expect(typeof value).toBe(type);
}

/** Customer schema: every required key, with its type. */
function assertCustomer(value: unknown): asserts value is Customer {
  const customer = value as Customer;
  expect(Object.keys(customer)).toEqual(expect.arrayContaining(CUSTOMER_KEYS));
  expect(customer.id).toMatch(UUID_PATTERN);
  expect(typeof customer.name).toBe('string');
  expect(customer.name.length).toBeGreaterThanOrEqual(1);
  expect(customer.name.length).toBeLessThanOrEqual(80);
  expectNullOr(customer.phone, 'string');
  expectNullOr(customer.note, 'string');
  expectNullOr(customer.credit_limit, 'number');
  expect(Number.isInteger(customer.balance)).toBe(true);
  if (customer.oldest_debt_date !== null)
    expect(customer.oldest_debt_date).toMatch(DATE_PATTERN);
  if (customer.debt_age_days !== null) {
    expect(Number.isInteger(customer.debt_age_days)).toBe(true);
    expect(customer.debt_age_days).toBeGreaterThanOrEqual(0);
  }
  expect(typeof customer.overdue).toBe('boolean');
  expect(typeof customer.archived).toBe('boolean');
  expect(Number.isNaN(Date.parse(customer.created_at))).toBe(false);
  expect(Number.isNaN(Date.parse(customer.updated_at))).toBe(false);
  // A customer is overdue only when its oldest unsettled credit is older than 7 days.
  expect(customer.overdue).toBe(
    customer.debt_age_days !== null && customer.debt_age_days > 7,
  );
}

/** DebtEntry schema, including the sign rule of each kind. */
function assertDebtEntry(value: unknown): asserts value is DebtEntry {
  const entry = value as DebtEntry;
  expect(Object.keys(entry)).toEqual(expect.arrayContaining(ENTRY_KEYS));
  expect(entry.id).toMatch(UUID_PATTERN);
  expect(entry.customer_id).toMatch(UUID_PATTERN);
  expect(['credit_sale', 'repayment', 'adjustment', 'void']).toContain(
    entry.kind,
  );
  expect(Number.isInteger(entry.amount)).toBe(true);
  expect(Number.isInteger(entry.balance_after)).toBe(true);
  if (entry.sale_id !== null) expect(entry.sale_id).toMatch(UUID_PATTERN);
  if (entry.method !== null)
    expect(['cash', 'transfer']).toContain(entry.method);
  expectNullOr(entry.reason, 'string');
  expect(entry.member_id).toMatch(UUID_PATTERN);
  expect(entry.business_date).toMatch(DATE_PATTERN);
  expect(Number.isNaN(Date.parse(entry.created_at))).toBe(false);
  if (entry.kind === 'credit_sale') expect(entry.amount).toBeGreaterThan(0);
  if (entry.kind === 'repayment') expect(entry.amount).toBeLessThan(0);
  if (entry.kind === 'void') expect(entry.amount).toBeLessThan(0);
  if (entry.kind === 'adjustment') expect(entry.amount).not.toBe(0);
  if (entry.kind === 'credit_sale' || entry.kind === 'void')
    expect(entry.sale_id).not.toBeNull();
  if (entry.kind === 'repayment') expect(entry.method).not.toBeNull();
}

function assertDebtSummary(value: unknown): asserts value is DebtSummary {
  const summary = value as DebtSummary;
  for (const key of [
    'total_outstanding',
    'customers_with_debt',
    'overdue_count',
    'overdue_amount',
  ] as const) {
    expect(Number.isInteger(summary[key])).toBe(true);
    expect(summary[key]).toBeGreaterThanOrEqual(0);
  }
  expect(Array.isArray(summary.top_debtors)).toBe(true);
  expect(summary.top_debtors.length).toBeLessThanOrEqual(5);
  summary.top_debtors.forEach(assertCustomer);
}

function assertDayClose(value: unknown): asserts value is DayClose {
  const close = value as DayClose;
  expect(close.business_date).toMatch(DATE_PATTERN);
  for (const key of [
    'opening_float',
    'cash_sales',
    'cash_refunds',
    'cash_repayments',
    'transfer_repayments',
    'credit_sales',
    'cash_expenses',
    'expected_cash',
    'counted_cash',
    'difference',
    'transfer_revenue',
  ] as const)
    expect(Number.isInteger(close[key]), `day close ${key}`).toBe(true);
  expect(close.closed_by).toMatch(UUID_PATTERN);
  expect(Number.isNaN(Date.parse(close.closed_at))).toBe(false);
}

/** Asia/Ho_Chi_Minh business date `daysAgo` days before now (UTC+7, no DST). */
function businessDateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS + 7 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function createCustomer(
  client: ApiClient,
  overrides?: Partial<CreateCustomerRequest>,
): Promise<Customer> {
  const body: CreateCustomerRequest = {
    id: uuid7(),
    name: uniqueName('Khach'),
    ...overrides,
  };
  const { data, error, response } = await client.raw.POST('/v1/customers', {
    body,
  });
  expect(response.status, JSON.stringify(error)).toBe(201);
  assertCustomer(data);
  return data;
}

async function getCustomer(
  client: ApiClient,
  customerId: string,
): Promise<Customer> {
  const { data, error, response } = await client.raw.GET(
    '/v1/customers/{customerId}',
    { params: { path: { customerId } } },
  );
  expect(response.status, JSON.stringify(error)).toBe(200);
  assertCustomer(data);
  return data;
}

async function ledger(
  client: ApiClient,
  customerId: string,
): Promise<DebtEntry[]> {
  const { data, error, response } = await client.raw.GET(
    '/v1/customers/{customerId}/entries',
    { params: { path: { customerId } } },
  );
  expect(response.status, JSON.stringify(error)).toBe(200);
  expect(data!.next_cursor).toBeNull();
  const items = data!.items!;
  items.forEach(assertDebtEntry);
  return items;
}

interface SaleOptions {
  method: 'cash' | 'transfer' | 'credit';
  total?: number;
  customerId?: string;
  creditAmount?: number;
  cashReceived?: number;
  soldAt?: string;
}

function saleBody(options: SaleOptions): CreateSaleRequest {
  const total = options.total ?? 30_000;
  return {
    id: uuid7(),
    sold_at: options.soldAt ?? new Date().toISOString(),
    payment_method: options.method,
    ...(options.customerId !== undefined && options.creditAmount !== undefined
      ? {
          credit: {
            customer_id: options.customerId,
            amount: options.creditAmount,
          },
        }
      : {}),
    ...(options.cashReceived !== undefined
      ? { cash_received: options.cashReceived }
      : {}),
    total,
    lines: [
      {
        id: uuid7(),
        product_id: null,
        source: 'manual',
        quantity: 1,
        unit_price: total,
        manual_label: 'Hang ghi no',
      },
    ],
  };
}

async function recordSale(
  client: ApiClient,
  options: SaleOptions,
): Promise<Sale> {
  const { data, error, response } = await client.raw.POST('/v1/sales', {
    body: saleBody(options),
  });
  expect(response.status, JSON.stringify(error)).toBe(201);
  return data!;
}

interface EntryResult {
  status: number;
  entry: DebtEntry | undefined;
  error: unknown;
}

/** POST /v1/customers/{id}/repayments; `key: null` omits the Idempotency-Key header. */
async function repay(
  client: ApiClient,
  customerId: string,
  body: components['schemas']['CreateRepaymentRequest'],
  key: string | null = randomUUID(),
): Promise<EntryResult> {
  const { data, error, response } = await client.raw.POST(
    '/v1/customers/{customerId}/repayments',
    {
      params: {
        path: { customerId },
        header: key === null ? {} : { 'Idempotency-Key': key },
      } as never,
      body,
    },
  );
  return { status: response.status, entry: data, error };
}

/** POST /v1/customers/{id}/adjustments; `key: null` omits the Idempotency-Key header. */
async function adjust(
  client: ApiClient,
  customerId: string,
  body: components['schemas']['CreateDebtAdjustmentRequest'],
  key: string | null = randomUUID(),
): Promise<EntryResult> {
  const { data, error, response } = await client.raw.POST(
    '/v1/customers/{customerId}/adjustments',
    {
      params: {
        path: { customerId },
        header: key === null ? {} : { 'Idempotency-Key': key },
      } as never,
      body,
    },
  );
  return { status: response.status, entry: data, error };
}

describe('Debt book (X5)', () => {
  describe('customers', () => {
    it('creates with 201, replays an identical body with 200, rejects a changed body with 409 and 404s an unknown id', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);

      const body: CreateCustomerRequest = {
        id: uuid7(),
        name: `Chi Lan ${uniqueName('c')}`,
        phone: '0912345678',
        note: 'Mua chiu cuoi thang',
        credit_limit: 500_000,
      };
      const created = await sellerClient.raw.POST('/v1/customers', { body });
      expect(created.response.status, JSON.stringify(created.error)).toBe(201);
      assertCustomer(created.data);
      expect(created.data).toMatchObject({
        id: body.id,
        name: body.name,
        phone: '0912345678',
        note: 'Mua chiu cuoi thang',
        credit_limit: 500_000,
        balance: 0,
        oldest_debt_date: null,
        debt_age_days: null,
        overdue: false,
        archived: false,
      });

      // Outbox-style replay of the identical body => 200, the same stored customer.
      const replay = await sellerClient.raw.POST('/v1/customers', { body });
      expect(replay.response.status).toBe(200);
      expect(replay.data).toEqual(created.data);

      // The same client id with any other body => 409 id_conflict.
      const conflict = await sellerClient.raw.POST('/v1/customers', {
        body: { ...body, name: 'Ten khac' },
      });
      expect(conflict.response.status).toBe(409);
      assertErrorResponse(conflict.error, 'id_conflict');

      // Read back, and the Lead sees the seller's customer in the search.
      expect(await getCustomer(leadClient, body.id)).toEqual(created.data);
      const listed = await leadClient.raw.GET('/v1/customers');
      expect(listed.response.status).toBe(200);
      expect(listed.data!.items!.map((c) => c.id)).toContain(body.id);

      const unknown = await sellerClient.raw.GET('/v1/customers/{customerId}', {
        params: { path: { customerId: uuid7() } },
      });
      expect(unknown.response.status).toBe(404);
      assertErrorResponse(unknown.error, 'not_found');
    });
  });

  describe('credit sales', () => {
    it('a full credit sale (payment_method credit, credit.amount = total) raises the balance and writes one credit_sale entry', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient, session: seller } =
        await joinAsSeller(leadClient);
      const customer = await createCustomer(sellerClient);

      const total = 45_000;
      const body = saleBody({
        method: 'credit',
        total,
        customerId: customer.id,
        creditAmount: total,
      });
      const created = await sellerClient.raw.POST('/v1/sales', { body });
      expect(created.response.status, JSON.stringify(created.error)).toBe(201);
      const sale = created.data!;
      expect(sale).toMatchObject({
        id: body.id,
        status: 'completed',
        payment_method: 'credit',
        total,
        credit_amount: total,
        customer_id: customer.id,
        member_id: seller.member.id,
      });
      expect(sale.cash_received ?? null).toBeNull();
      expect(sale.change_given ?? null).toBeNull();

      const after = await getCustomer(sellerClient, customer.id);
      expect(after.balance).toBe(total);
      expect(after.oldest_debt_date).toBe(sale.business_date);
      expect(after.debt_age_days).toBe(0);
      expect(after.overdue).toBe(false);

      const entries = await ledger(sellerClient, customer.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        customer_id: customer.id,
        kind: 'credit_sale',
        amount: total,
        balance_after: total,
        sale_id: sale.id,
        method: null,
        member_id: seller.member.id,
        business_date: sale.business_date,
      });

      // Replaying the same sale adds nothing: 200, same sale, one entry, same balance.
      const replay = await sellerClient.raw.POST('/v1/sales', { body });
      expect(replay.response.status).toBe(200);
      expect(replay.data!.id).toBe(sale.id);
      expect(await ledger(sellerClient, customer.id)).toHaveLength(1);
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        total,
      );

      // The credit method filter finds the sale.
      const credits = await sellerClient.raw.GET('/v1/sales', {
        params: { query: { payment_method: 'credit' } },
      });
      expect(credits.response.status).toBe(200);
      expect(credits.data!.items.map((s) => s.id)).toEqual([sale.id]);

      // credit.amount must equal the total for payment_method credit: nothing is stored.
      const partial = saleBody({
        method: 'credit',
        total,
        customerId: customer.id,
        creditAmount: total - 1,
      });
      const rejected = await sellerClient.raw.POST('/v1/sales', {
        body: partial,
      });
      expect(rejected.response.status).toBe(400);
      assertErrorResponse(rejected.error, 'validation_failed');
      const absent = await sellerClient.raw.GET('/v1/sales/{saleId}', {
        params: { path: { saleId: partial.id } },
      });
      expect(absent.response.status).toBe(404);

      // An unknown customer is a 404 and leaves no sale behind.
      const orphan = saleBody({
        method: 'credit',
        total,
        customerId: uuid7(),
        creditAmount: total,
      });
      const unknown = await sellerClient.raw.POST('/v1/sales', {
        body: orphan,
      });
      expect(unknown.response.status).toBe(404);
      assertErrorResponse(unknown.error, 'not_found');
      expect(await ledger(sellerClient, customer.id)).toHaveLength(1);
    });

    it('a partial cash credit sale gives change on the paid part only and owes the rest', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);
      const customer = await createCustomer(sellerClient);

      // total 30000, credit 12000: the customer pays 18000 now and hands over 20000.
      const sale = await recordSale(sellerClient, {
        method: 'cash',
        total: 30_000,
        customerId: customer.id,
        creditAmount: 12_000,
        cashReceived: 20_000,
      });
      expect(sale).toMatchObject({
        payment_method: 'cash',
        total: 30_000,
        credit_amount: 12_000,
        customer_id: customer.id,
        cash_received: 20_000,
        change_given: 2_000,
      });

      const stored = await sellerClient.raw.GET('/v1/sales/{saleId}', {
        params: { path: { saleId: sale.id } },
      });
      expect(stored.response.status).toBe(200);
      expect(stored.data!.change_given).toBe(2_000);
      expect(stored.data!.credit_amount).toBe(12_000);

      const after = await getCustomer(sellerClient, customer.id);
      expect(after.balance).toBe(12_000);
      const entries = await ledger(sellerClient, customer.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'credit_sale',
        amount: 12_000,
        balance_after: 12_000,
        sale_id: sale.id,
      });

      // One dong short of the paid part (18000) is rejected and changes nothing.
      const short = saleBody({
        method: 'cash',
        total: 30_000,
        customerId: customer.id,
        creditAmount: 12_000,
        cashReceived: 17_999,
      });
      const rejected = await sellerClient.raw.POST('/v1/sales', {
        body: short,
      });
      expect(rejected.response.status).toBe(400);
      assertErrorResponse(rejected.error, 'validation_failed');
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        12_000,
      );

      // Exactly the paid part: no change.
      const exact = await recordSale(sellerClient, {
        method: 'cash',
        total: 30_000,
        customerId: customer.id,
        creditAmount: 12_000,
        cashReceived: 18_000,
      });
      expect(exact.change_given).toBe(0);
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        24_000,
      );
    });

    it('voiding a credit sale adds a reversing void entry once and clears the debt', async () => {
      const { client: leadClient, session: lead } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);
      const customer = await createCustomer(sellerClient);

      const total = 20_000;
      const sale = await recordSale(sellerClient, {
        method: 'credit',
        total,
        customerId: customer.id,
        creditAmount: total,
      });
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        total,
      );

      const voidPath = {
        params: { path: { saleId: sale.id } },
        body: { reason: 'Khach tra hang' },
      };
      const voided = await leadClient.raw.POST(
        '/v1/sales/{saleId}/void',
        voidPath,
      );
      expect(voided.response.status, JSON.stringify(voided.error)).toBe(200);
      expect(voided.data!.status).toBe('voided');
      expect(voided.data!.credit_amount).toBe(total);

      const after = await getCustomer(sellerClient, customer.id);
      expect(after.balance).toBe(0);
      expect(after.oldest_debt_date).toBeNull();
      expect(after.debt_age_days).toBeNull();
      expect(after.overdue).toBe(false);

      const entries = await ledger(sellerClient, customer.id);
      expect(entries.map((e) => e.kind)).toEqual(['void', 'credit_sale']);
      expect(entries[0]).toMatchObject({
        amount: -total,
        balance_after: 0,
        sale_id: sale.id,
        method: null,
        member_id: lead.member.id,
      });
      expect(entries[1]).toMatchObject({
        amount: total,
        balance_after: total,
        sale_id: sale.id,
      });

      // Voiding twice is a no-op: same answer, no second reversal.
      const again = await leadClient.raw.POST('/v1/sales/{saleId}/void', {
        ...voidPath,
        body: { reason: 'Bam lan nua' },
      });
      expect(again.response.status).toBe(200);
      expect(await ledger(sellerClient, customer.id)).toHaveLength(2);
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(0);
    });
  });

  describe('repayments and adjustments', () => {
    it('records repayments idempotently, rejects a missing key with 422 and lets an overpayment make the balance negative', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient, session: seller } =
        await joinAsSeller(leadClient);
      const customer = await createCustomer(sellerClient);
      await recordSale(sellerClient, {
        method: 'credit',
        total: 30_000,
        customerId: customer.id,
        creditAmount: 30_000,
      });

      const key = randomUUID();
      const body = { amount: 10_000, method: 'cash' } as const;
      const first = await repay(sellerClient, customer.id, body, key);
      expect(first.status, JSON.stringify(first.error)).toBe(201);
      assertDebtEntry(first.entry);
      expect(first.entry).toMatchObject({
        customer_id: customer.id,
        kind: 'repayment',
        amount: -10_000, // the API takes a positive amount; the ledger stores it negative
        balance_after: 20_000,
        method: 'cash',
        sale_id: null,
        member_id: seller.member.id,
      });
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        20_000,
      );

      // Same key and body => 200 and the very same entry; the balance moved once.
      const replay = await repay(sellerClient, customer.id, body, key);
      expect(replay.status).toBe(200);
      expect(replay.entry).toEqual(first.entry);
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        20_000,
      );
      expect(await ledger(sellerClient, customer.id)).toHaveLength(2);

      // The same key with another body, or for another customer, is a conflict.
      const changed = await repay(
        sellerClient,
        customer.id,
        { amount: 10_001, method: 'cash' },
        key,
      );
      expect(changed.status).toBe(409);
      assertErrorResponse(changed.error, 'id_conflict');
      const other = await createCustomer(sellerClient);
      const elsewhere = await repay(sellerClient, other.id, body, key);
      expect(elsewhere.status).toBe(409);
      assertErrorResponse(elsewhere.error, 'id_conflict');

      // No Idempotency-Key, or an invalid body, is 422 and records nothing.
      const keyless = await repay(sellerClient, customer.id, body, null);
      expect(keyless.status).toBe(422);
      assertErrorResponse(keyless.error);
      for (const invalid of [
        { amount: 0, method: 'cash' },
        { amount: -5, method: 'cash' },
        { amount: 5, method: 'card' },
      ]) {
        const result = await repay(sellerClient, customer.id, invalid as never);
        expect(result.status, JSON.stringify(invalid)).toBe(422);
        assertErrorResponse(result.error, 'validation_failed');
      }
      expect(await ledger(sellerClient, customer.id)).toHaveLength(2);

      // Paying the rest by transfer settles the debt: no oldest debt, not overdue.
      const settle = await repay(sellerClient, customer.id, {
        amount: 20_000,
        method: 'transfer',
      });
      expect(settle.status).toBe(201);
      expect(settle.entry).toMatchObject({
        amount: -20_000,
        balance_after: 0,
        method: 'transfer',
      });
      const settled = await getCustomer(sellerClient, customer.id);
      expect(settled.balance).toBe(0);
      expect(settled.oldest_debt_date).toBeNull();
      expect(settled.debt_age_days).toBeNull();
      expect(settled.overdue).toBe(false);

      // Overpayment is allowed: the store holds the customer's money (negative balance).
      const over = await repay(sellerClient, customer.id, {
        amount: 5_000,
        method: 'cash',
      });
      expect(over.status).toBe(201);
      expect(over.entry!.balance_after).toBe(-5_000);
      expect((await getCustomer(sellerClient, customer.id)).balance).toBe(
        -5_000,
      );

      // Newest first, and the ledger pages with a cursor.
      const entries = await ledger(sellerClient, customer.id);
      expect(entries.map((e) => e.kind)).toEqual([
        'repayment',
        'repayment',
        'repayment',
        'credit_sale',
      ]);
      expect(entries.map((e) => e.balance_after)).toEqual([
        -5_000, 0, 20_000, 30_000,
      ]);
      const page = await sellerClient.raw.GET(
        '/v1/customers/{customerId}/entries',
        { params: { path: { customerId: customer.id }, query: { limit: 3 } } },
      );
      expect(page.response.status).toBe(200);
      expect(page.data!.items).toHaveLength(3);
      expect(page.data!.next_cursor).toEqual(expect.any(String));
      const rest = await sellerClient.raw.GET(
        '/v1/customers/{customerId}/entries',
        {
          params: {
            path: { customerId: customer.id },
            query: { limit: 3, cursor: page.data!.next_cursor! },
          },
        },
      );
      expect(rest.response.status).toBe(200);
      expect(rest.data!.items!.map((e) => e.id)).toEqual([entries[3]!.id]);
      expect(rest.data!.next_cursor).toBeNull();
    });

    it('lets only the Lead adjust: the seller gets 403, the Lead writes the debt up and down, and a retry replays', async () => {
      const { client: leadClient, session: lead } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);
      const customer = await createCustomer(sellerClient);

      const denied = await adjust(sellerClient, customer.id, {
        amount: 7_000,
        reason: 'No cu',
      });
      expect(denied.status).toBe(403);
      assertErrorResponse(denied.error);
      expect(await ledger(leadClient, customer.id)).toEqual([]);

      const key = randomUUID();
      const up = await adjust(
        leadClient,
        customer.id,
        { amount: 7_000, reason: 'No cu tu so giay' },
        key,
      );
      expect(up.status, JSON.stringify(up.error)).toBe(201);
      assertDebtEntry(up.entry);
      expect(up.entry).toMatchObject({
        customer_id: customer.id,
        kind: 'adjustment',
        amount: 7_000,
        balance_after: 7_000,
        reason: 'No cu tu so giay',
        method: null,
        sale_id: null,
        member_id: lead.member.id,
      });

      const replay = await adjust(
        leadClient,
        customer.id,
        { amount: 7_000, reason: 'No cu tu so giay' },
        key,
      );
      expect(replay.status).toBe(200);
      expect(replay.entry).toEqual(up.entry);

      const writeOff = await adjust(leadClient, customer.id, {
        amount: -2_000,
        reason: 'Xoa no le',
      });
      expect(writeOff.status).toBe(201);
      expect(writeOff.entry).toMatchObject({
        kind: 'adjustment',
        amount: -2_000,
        balance_after: 5_000,
      });
      expect((await getCustomer(leadClient, customer.id)).balance).toBe(5_000);

      const keyless = await adjust(
        leadClient,
        customer.id,
        { amount: 1, reason: 'Thieu khoa' },
        null,
      );
      expect(keyless.status).toBe(422);
      assertErrorResponse(keyless.error);
      const zero = await adjust(leadClient, customer.id, {
        amount: 0,
        reason: 'Khong doi',
      });
      expect(zero.status).toBe(422);
      expect(await ledger(leadClient, customer.id)).toHaveLength(2);
    });
  });

  describe('book queries', () => {
    it('searches by name and phone, filters overdue, sorts, and summarises the debt', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);
      const token = uniqueName('tk');
      const phone = `09${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
      const old = await createCustomer(sellerClient, {
        name: `Chi Lan ${token}`,
        phone,
      });
      const fresh = await createCustomer(sellerClient, {
        name: `Anh Minh ${token}`,
      });
      const clean = await createCustomer(sellerClient, {
        name: `Co Hoa ${token}`,
      });

      // An old debt needs an adjustment dated 10 days ago (the Lead's); fresh debt is today's.
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
      const aged = await adjust(leadClient, old.id, {
        amount: 100_000,
        reason: 'No cu 10 ngay',
        adjusted_at: tenDaysAgo,
      });
      expect(aged.status, JSON.stringify(aged.error)).toBe(201);
      expect(aged.entry!.business_date).toBe(businessDateDaysAgo(10));
      const recent = await adjust(leadClient, fresh.id, {
        amount: 50_000,
        reason: 'No moi',
      });
      expect(recent.status).toBe(201);

      const overdueCustomer = await getCustomer(sellerClient, old.id);
      expect(overdueCustomer).toMatchObject({
        balance: 100_000,
        oldest_debt_date: businessDateDaysAgo(10),
        debt_age_days: 10,
        overdue: true,
      });
      expect(await getCustomer(sellerClient, fresh.id)).toMatchObject({
        balance: 50_000,
        debt_age_days: 0,
        overdue: false,
      });

      async function search(query: Record<string, string | boolean>) {
        const { data, error, response } = await sellerClient.raw.GET(
          '/v1/customers',
          { params: { query } },
        );
        expect(response.status, JSON.stringify(error)).toBe(200);
        data!.items!.forEach(assertCustomer);
        return data!.items!.map((c) => c.id);
      }

      // Case-insensitive substring of the name; all three share the token. By name:
      // "Anh Minh", "Chi Lan", "Co Hoa".
      expect(
        await search({ query: token.toUpperCase(), sort: 'name' }),
      ).toEqual([fresh.id, old.id, clean.id]);
      expect(await search({ query: 'minh ' + token })).toEqual([fresh.id]);
      // Phone substring, and no match.
      expect(await search({ query: phone.slice(2, 8) })).toEqual([old.id]);
      expect(await search({ query: `khong-co-${token}` })).toEqual([]);
      // Overdue filter: only the 10-day-old debt.
      expect(await search({ overdue: true })).toEqual([old.id]);
      expect(await search({ query: token, overdue: true })).toEqual([old.id]);
      // Largest balance first by default; zero-balance customers come last.
      expect(await search({ query: token, sort: 'balance' })).toEqual([
        old.id,
        fresh.id,
        clean.id,
      ]);

      const summary = await sellerClient.raw.GET('/v1/debts/summary');
      expect(summary.response.status).toBe(200);
      assertDebtSummary(summary.data);
      expect(summary.data).toMatchObject({
        total_outstanding: 150_000,
        customers_with_debt: 2,
        overdue_count: 1,
        overdue_amount: 100_000,
      });
      expect(summary.data.top_debtors.map((c) => c.id)).toEqual([
        old.id,
        fresh.id,
      ]);
      expect(summary.data.top_debtors[0]).toEqual(overdueCustomer);

      // Paying the old debt in full clears it from the overdue filter and the summary.
      const paid = await repay(sellerClient, old.id, {
        amount: 100_000,
        method: 'transfer',
      });
      expect(paid.status).toBe(201);
      expect(await search({ overdue: true })).toEqual([]);
      const after = await sellerClient.raw.GET('/v1/debts/summary');
      assertDebtSummary(after.data);
      expect(after.data).toMatchObject({
        total_outstanding: 50_000,
        customers_with_debt: 1,
        overdue_count: 0,
        overdue_amount: 0,
      });
      expect(after.data.top_debtors.map((c) => c.id)).toEqual([fresh.id]);
    });
  });

  describe('change feed', () => {
    it('carries customer and debt_entry upserts that match the API, and only newer ones after a cursor', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);
      const customer = await createCustomer(sellerClient);
      const sale = await recordSale(sellerClient, {
        method: 'credit',
        total: 18_000,
        customerId: customer.id,
        creditAmount: 18_000,
      });

      const snapshot = await sellerClient.raw.GET('/v1/sync/changes');
      expect(snapshot.response.status).toBe(200);
      const changes = snapshot.data!.changes;
      const customerChange = changes
        .filter((c) => c.entity === 'customer' && c.id === customer.id)
        .at(-1);
      expect(customerChange).toMatchObject({ op: 'upsert' });
      expect(customerChange!.data).toEqual(
        await getCustomer(sellerClient, customer.id),
      );
      const [creditEntry] = await ledger(sellerClient, customer.id);
      const entryChange = changes.find(
        (c) => c.entity === 'debt_entry' && c.id === creditEntry!.id,
      );
      expect(entryChange).toMatchObject({ op: 'upsert' });
      expect(entryChange!.data).toEqual(creditEntry);
      expect(creditEntry).toMatchObject({
        kind: 'credit_sale',
        sale_id: sale.id,
      });

      // After the cursor only the repayment and the customer's new balance arrive.
      const repayment = await repay(sellerClient, customer.id, {
        amount: 8_000,
        method: 'cash',
      });
      expect(repayment.status).toBe(201);
      const delta = await sellerClient.raw.GET('/v1/sync/changes', {
        params: { query: { since: snapshot.data!.cursor } },
      });
      expect(delta.response.status).toBe(200);
      const fresh = delta.data!.changes;
      expect(fresh.every((c) => c.op === 'upsert')).toBe(true);
      expect(
        fresh.filter((c) => c.entity === 'debt_entry').map((c) => c.id),
      ).toEqual([repayment.entry!.id]);
      const updated = fresh.filter(
        (c) => c.entity === 'customer' && c.id === customer.id,
      );
      expect(updated.length).toBeGreaterThanOrEqual(1);
      expect((updated.at(-1)!.data as Customer).balance).toBe(10_000);
      expect(delta.data!.cursor).not.toBe(snapshot.data!.cursor);
    });
  });

  describe('day close', () => {
    it('reports repayments by method and credit sales, counts only paid parts, and includes cash repayments in expected_cash', async () => {
      const { client: leadClient, session: lead } = await createStore();
      const { client: sellerClient, session: seller } =
        await joinAsSeller(leadClient);
      const lan = await createCustomer(sellerClient);
      const minh = await createCustomer(sellerClient);

      // One instant for every record keeps them on the same business date.
      const at = new Date().toISOString();
      const sold = (options: SaleOptions) =>
        recordSale(sellerClient, { ...options, soldAt: at });
      const plainCash = await sold({
        method: 'cash',
        total: 20_000,
        cashReceived: 20_000,
      });
      // 30000 total, 12000 owed: 18000 paid in cash (change 2000).
      await sold({
        method: 'cash',
        total: 30_000,
        customerId: lan.id,
        creditAmount: 12_000,
        cashReceived: 20_000,
      });
      await sold({
        method: 'credit',
        total: 15_000,
        customerId: minh.id,
        creditAmount: 15_000,
      });
      // 10000 total, 4000 owed: 6000 paid by transfer.
      await sold({
        method: 'transfer',
        total: 10_000,
        customerId: lan.id,
        creditAmount: 4_000,
      });
      await sold({ method: 'transfer', total: 9_000 });
      const businessDate = plainCash.business_date;

      const spent = await sellerClient.raw.POST('/v1/expenses', {
        body: {
          id: uuid7(),
          spent_at: at,
          amount: 2_500,
          category: 'dien',
          paid_with: 'cash_box',
        },
      });
      expect(spent.response.status, JSON.stringify(spent.error)).toBe(201);

      for (const [customer, amount, method] of [
        [lan, 5_000, 'cash'],
        [lan, 3_000, 'transfer'],
        [minh, 2_000, 'cash'],
      ] as const) {
        const result = await repay(sellerClient, customer.id, {
          amount,
          method,
          paid_at: at,
        });
        expect(result.status, JSON.stringify(result.error)).toBe(201);
        expect(result.entry!.business_date).toBe(businessDate);
      }

      // Revenue is the full total of every sale; the split counts only what was paid.
      const today = await leadClient.raw.GET('/v1/reports/today', {
        params: { query: { date: businessDate } },
      });
      expect(today.response.status, JSON.stringify(today.error)).toBe(200);
      expect(today.data).toMatchObject({
        business_date: businessDate,
        revenue: 84_000,
        sales_count: 5,
        cash_revenue: 38_000,
        transfer_revenue: 15_000,
        expenses: 2_500,
        // 38000 cash sales + 7000 cash repayments - 2500 cash expenses
        expected_cash: 42_500,
      });

      const openingFloat = 10_000;
      const expectedCash = openingFloat + 38_000 - 0 + 7_000 - 2_500;
      const countedCash = 52_000;
      const put = await leadClient.raw.PUT('/v1/day-closes/{businessDate}', {
        params: { path: { businessDate } },
        body: { counted_cash: countedCash, opening_float: openingFloat },
      });
      expect(put.response.status, JSON.stringify(put.error)).toBe(200);
      assertDayClose(put.data);
      expect(put.data).toMatchObject({
        business_date: businessDate,
        opening_float: openingFloat,
        cash_sales: 38_000,
        cash_refunds: 0,
        cash_repayments: 7_000,
        transfer_repayments: 3_000,
        credit_sales: 31_000,
        cash_expenses: 2_500,
        expected_cash: expectedCash,
        counted_cash: countedCash,
        difference: countedCash - expectedCash,
        transfer_revenue: 15_000,
        closed_by: lead.member.id,
      });

      // The seller cannot close the day; the stored close reads back unchanged.
      const asSeller = await sellerClient.raw.PUT(
        '/v1/day-closes/{businessDate}',
        {
          params: { path: { businessDate } },
          body: { counted_cash: 0 },
        },
      );
      expect(asSeller.response.status).toBe(403);
      assertErrorResponse(asSeller.error);
      const fetched = await leadClient.raw.GET(
        '/v1/day-closes/{businessDate}',
        {
          params: { path: { businessDate } },
        },
      );
      expect(fetched.response.status).toBe(200);
      assertDayClose(fetched.data);
      expect(fetched.data).toMatchObject({
        cash_repayments: 7_000,
        transfer_repayments: 3_000,
        credit_sales: 31_000,
        expected_cash: expectedCash,
        difference: countedCash - expectedCash,
      });
      expect(seller.member.id).not.toBe(lead.member.id);
    });
  });
});
