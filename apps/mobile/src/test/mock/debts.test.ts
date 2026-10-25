import * as api from '@/lib/api/debts';
import { createSale } from '@/lib/api/ledger';
import { getApiClient } from '@/lib/api/client';
import type { CreateSaleRequest } from '@/lib/api/types';
import { newUuid } from '@/lib/uuid';
import { addDays, businessDate } from '@/lib/date';
import { freezeDate } from '../clock';
import { getMockDb } from './db';
import { getDailyReport, putDayClose } from './ledger';

const customer = () => api.createCustomer({ id: newUuid(), name: 'Chị Lan' });
const sale = (
  customerId: string,
  extra: Partial<CreateSaleRequest> = {},
): CreateSaleRequest => ({
  id: newUuid(),
  sold_at: new Date().toISOString(),
  payment_method: 'credit',
  total: 10000,
  credit: { customer_id: customerId, amount: 10000 },
  lines: [
    {
      id: newUuid(),
      product_id: null,
      source: 'manual',
      manual_label: 'Gạo',
      quantity: 1,
      unit_price: 10000,
    },
  ],
  ...extra,
});

test('full and partial credit sales update balance once on replay', async () => {
  const c = await customer();
  const req = sale(c.id);
  expect(await createSale(req)).toMatchObject({
    credit_amount: 10000,
    customer_id: c.id,
    cash_received: null,
  });
  await createSale(req);
  expect((await api.getCustomer(c.id)).balance).toBe(10000);
  expect(
    await createSale(
      sale(c.id, {
        payment_method: 'cash',
        cash_received: 4000,
        credit: { customer_id: c.id, amount: 7000 },
      }),
    ),
  ).toMatchObject({ credit_amount: 7000, change_given: 1000 });
  expect((await api.getCustomer(c.id)).balance).toBe(17000);
  expect((await api.listDebtEntries(c.id)).items).toHaveLength(2);
});

test('customer create replays on id and conflicts on a changed body', async () => {
  const req = { id: newUuid(), name: 'Lan' };
  expect(await api.createCustomer(req)).toEqual(await api.createCustomer(req));
  await expect(
    api.createCustomer({ ...req, name: 'Mai' }),
  ).rejects.toMatchObject({ status: 409 });
});

test('rejects invalid credit combinations atomically and unknown customer is 404', async () => {
  const c = await customer();
  for (const extra of [
    { credit: undefined },
    { cash_received: 0 },
    { credit: { customer_id: c.id, amount: 9000 } },
    { payment_method: 'cash' as const },
    { payment_method: 'transfer' as const },
    {
      payment_method: 'cash' as const,
      cash_received: 1000,
      credit: { customer_id: c.id, amount: 7000 },
    },
    {
      payment_method: 'cash' as const,
      credit: { customer_id: c.id, amount: 0 },
    },
  ])
    await expect(createSale(sale(c.id, extra))).rejects.toBeDefined();
  await expect(createSale(sale(newUuid()))).rejects.toMatchObject({
    status: 404,
  });
  expect((await api.getCustomer(c.id)).balance).toBe(0);
});

test('repayment is idempotent, keys conflict across customers and overpayment is allowed', async () => {
  const c = await customer();
  const key = newUuid();
  const body = { amount: 12000, method: 'cash' as const };
  const entry = await api.createRepayment(c.id, body, key);
  expect(await api.createRepayment(c.id, body, key)).toEqual(entry);
  expect((await api.getCustomer(c.id)).balance).toBe(-12000);
  await expect(
    api.createRepayment(c.id, { ...body, amount: 1 }, key),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    api.createRepayment((await customer()).id, body, key),
  ).rejects.toMatchObject({ status: 409 });
  const response = await getApiClient().raw.POST(
    '/v1/customers/{customerId}/repayments',
    {
      params: { path: { customerId: c.id }, header: { 'Idempotency-Key': '' } },
      body,
    },
  );
  expect(response.response.status).toBe(422);
});

test('FIFO aging uses business dates; void cancels only its sale and replay adds nothing', async () => {
  const c = await customer();
  const older = sale(c.id, {
    sold_at: `${addDays(businessDate(), -9)}T05:00:00Z`,
  });
  const newer = sale(c.id, {
    sold_at: `${addDays(businessDate(), -7)}T05:00:00Z`,
  });
  await createSale(older);
  await createSale(newer);
  expect(await api.getCustomer(c.id)).toMatchObject({
    overdue: true,
    debt_age_days: 9,
  });
  await api.createRepayment(
    c.id,
    { amount: 5000, method: 'transfer' },
    newUuid(),
  );
  for (let i = 0; i < 2; i++) {
    const result = await getApiClient().raw.POST('/v1/sales/{saleId}/void', {
      params: { path: { saleId: older.id } },
      body: { reason: 'Nhầm đơn' },
    });
    expect(result.response.ok).toBe(true);
  }
  expect(await api.getCustomer(c.id)).toMatchObject({
    balance: 5000,
    overdue: false,
    debt_age_days: 7,
  });
  expect(
    (await api.listDebtEntries(c.id)).items?.filter((e) => e.kind === 'void'),
  ).toHaveLength(1);
});

test('seller cannot adjust or archive; archived customers still accept credit and repayment', async () => {
  const c = await customer();
  const db = getMockDb();
  const lead = db.currentMemberId;
  db.currentMemberId = db.members.find((m) => m.role === 'seller')!.id;
  await expect(
    api.createDebtAdjustment(c.id, { amount: -1000, reason: 'Sửa' }, newUuid()),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    api.updateCustomer(c.id, { archived: true }),
  ).rejects.toMatchObject({ status: 403 });
  db.currentMemberId = lead;
  await api.updateCustomer(c.id, { archived: true });
  expect((await api.listCustomers()).items).toHaveLength(0);
  await createSale(sale(c.id));
  await api.createRepayment(c.id, { amount: 1000, method: 'cash' }, newUuid());
  expect((await api.getDebtSummary()).total_outstanding).toBe(9000);
});

test('day-close counts only paid cash and repayments; revenue includes credit', async () => {
  getMockDb().sales = [];
  getMockDb().expenses = [];
  const c = await customer();
  await createSale(sale(c.id));
  await createSale(
    sale(c.id, {
      payment_method: 'cash',
      cash_received: 3000,
      credit: { customer_id: c.id, amount: 7000 },
    }),
  );
  await api.createRepayment(c.id, { amount: 2000, method: 'cash' }, newUuid());
  await api.createRepayment(
    c.id,
    { amount: 1000, method: 'transfer' },
    newUuid(),
  );
  expect(getDailyReport()).toMatchObject({
    revenue: 20000,
    cash_revenue: 3000,
    expected_cash: 5000,
  });
  expect(
    putDayClose(businessDate(), {
      opening_float: 1000,
      counted_cash: 6000,
      note: null,
    }),
  ).toMatchObject({
    cash_sales: 3000,
    cash_repayments: 2000,
    transfer_repayments: 1000,
    credit_sales: 17000,
    expected_cash: 6000,
  });
});

test('customer search, archive filter, sort and pagination are preserved', async () => {
  const c = await api.createCustomer({
    id: newUuid(),
    name: 'Lan',
    phone: '0901234567',
  });
  await api.createCustomer({ id: newUuid(), name: 'Mai' });
  expect(
    (await api.listCustomers({ query: 'lAN' })).items?.map((c) => c.id),
  ).toEqual([c.id]);
  expect(
    (await api.listCustomers({ query: '0901' })).items?.map((c) => c.id),
  ).toEqual([c.id]);
  const page = await api.listCustomers({ sort: 'name', limit: 1 });
  expect(page.items?.[0].name).toBe('Lan');
  expect(page.next_cursor).toBeTruthy();
  expect(
    (
      await api.listCustomers({
        sort: 'name',
        cursor: page.next_cursor!,
        limit: 1,
      })
    ).items?.[0].name,
  ).toBe('Mai');
  await api.updateCustomer(c.id, { archived: true });
  expect(
    (await api.listCustomers({ archived: true })).items?.map((c) => c.id),
  ).toEqual([c.id]);
});

test('lead adjustments replay signed entries; changed reason conflicts and zero is rejected', async () => {
  const c = await customer();
  const key = newUuid();
  const body = {
    amount: 10000,
    reason: 'Số dư đầu kỳ',
    adjusted_at: `${addDays(businessDate(), -8)}T05:00:00Z`,
  };
  const entry = await api.createDebtAdjustment(c.id, body, key);
  expect(await api.createDebtAdjustment(c.id, body, key)).toEqual(entry);
  expect(await api.getCustomer(c.id)).toMatchObject({
    balance: 10000,
    debt_age_days: 8,
    overdue: true,
  });
  await api.createDebtAdjustment(
    c.id,
    { amount: -4000, reason: 'Sửa' },
    newUuid(),
  );
  expect((await api.getCustomer(c.id)).balance).toBe(6000);
  await expect(
    api.createDebtAdjustment(c.id, { ...body, reason: 'Khác' }, key),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    api.createDebtAdjustment(c.id, { amount: 0, reason: 'Sửa' }, newUuid()),
  ).rejects.toMatchObject({ status: 422 });
});

test('seller retains the existing ability to void their own same-day credit sale', async () => {
  const c = await customer();
  const db = getMockDb();
  db.currentMemberId = db.members.find((m) => m.role === 'seller')!.id;
  const created = await createSale(sale(c.id));
  const result = await getApiClient().raw.POST('/v1/sales/{saleId}/void', {
    params: { path: { saleId: created.id } },
    body: { reason: 'Nhầm đơn' },
  });
  expect(result.response.status).toBe(200);
  expect((await api.getCustomer(c.id)).balance).toBe(0);
});

test('the entries list is newest first even when entries share a millisecond', async () => {
  freezeDate(Date.now());
  const c = await customer();
  for (const amount of [1000, 2000, 3000, 4000, 5000, 6000])
    await api.createRepayment(c.id, { amount, method: 'cash' }, newUuid());
  expect(
    (await api.listDebtEntries(c.id)).items?.map((e) => -e.amount),
  ).toEqual([6000, 5000, 4000, 3000, 2000, 1000]);
});
