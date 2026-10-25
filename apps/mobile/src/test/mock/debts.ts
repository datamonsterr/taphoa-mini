import type {
  Customer,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  DebtEntry,
  DebtSummary,
  CreateSaleRequest,
  Sale,
} from '@/lib/api/types';
import { businessDate, daysBetween } from '@/lib/date';
import { newUuid } from '@/lib/uuid';
import { getMockDb, getCurrentMember, nowIso } from './db';
import {
  badRequest,
  conflict,
  MockHttpError,
  notFound,
  unprocessableEntity,
} from './errors';
import { asObject, isMoney, isUuid, paginate } from './validate';
import type { MockRoute } from './routes';

const stable = (value: unknown): string =>
  JSON.stringify(value, Object.keys(asObject(value)).sort());
const requireLead = () => {
  if (getCurrentMember().role !== 'lead')
    throw new MockHttpError(403, 'forbidden', 'Lead only');
};
const text = (value: unknown, max: number, min = 0): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length < min ||
    value.length > max
  )
    throw badRequest('Invalid text');
  return value;
};
const timestamp = (value: unknown): string => {
  if (value === undefined) return nowIso();
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw unprocessableEntity('Invalid date-time');
  return value;
};

export function getCustomer(id: string): Customer {
  const customer = getMockDb().customers.find((c) => c.id === id);
  if (!customer) throw notFound('Customer');
  const entries = getMockDb().debtEntries.filter((e) => e.customer_id === id);
  const voided = new Set(
    entries.filter((e) => e.kind === 'void').map((e) => e.sale_id),
  );
  const remaining = entries.filter(
    (e) =>
      e.kind !== 'void' && !(e.kind === 'credit_sale' && voided.has(e.sale_id)),
  );
  let settled = -remaining
    .filter((e) => e.amount < 0)
    .reduce((sum, e) => sum + e.amount, 0);
  let oldest: string | null = null;
  const positives = remaining
    .filter((e) => e.amount > 0)
    .sort(
      (a, b) =>
        a.business_date.localeCompare(b.business_date) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
  for (const entry of positives) {
    if (settled < entry.amount) {
      oldest = entry.business_date;
      break;
    }
    settled -= entry.amount;
  }
  customer.oldest_debt_date = customer.balance > 0 ? oldest : null;
  customer.debt_age_days = customer.oldest_debt_date
    ? daysBetween(customer.oldest_debt_date, businessDate())
    : null;
  customer.overdue = (customer.debt_age_days ?? 0) > 7;
  return customer;
}

export function createCustomer(value: unknown): {
  customer: Customer;
  created: boolean;
} {
  const body = asObject(value);
  if (!isUuid(body.id)) throw badRequest('Invalid id');
  const req: CreateCustomerRequest = {
    id: body.id,
    name: text(body.name, 80, 1),
  };
  if (body.phone !== undefined) req.phone = text(body.phone, 20);
  if (body.note !== undefined) req.note = text(body.note, 200);
  if (body.credit_limit !== undefined) {
    if (!isMoney(body.credit_limit)) throw badRequest('Invalid credit_limit');
    req.credit_limit = body.credit_limit;
  }
  const db = getMockDb();
  const key = `customer:${req.id}`;
  const previous = db.idempotency.get(key);
  if (previous) {
    if (previous.hash !== stable(req))
      throw conflict('id_conflict', 'Customer id reused');
    return { customer: getCustomer(req.id), created: false };
  }
  const customer: Customer = {
    id: req.id,
    name: req.name,
    phone: req.phone ?? null,
    note: req.note ?? null,
    credit_limit: req.credit_limit ?? null,
    balance: 0,
    oldest_debt_date: null,
    debt_age_days: null,
    overdue: false,
    archived: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.customers.push(customer);
  db.idempotency.set(key, { hash: stable(req), value: customer });
  return { customer, created: true };
}

export function updateCustomer(id: string, value: unknown): Customer {
  const body = asObject(value);
  if (body.archived !== undefined) requireLead();
  const c = getCustomer(id);
  const patch: UpdateCustomerRequest = {};
  if (body.name !== undefined) patch.name = text(body.name, 80, 1);
  for (const field of ['phone', 'note'] as const)
    if (body[field] !== undefined)
      patch[field] =
        body[field] === null
          ? null
          : text(body[field], field === 'phone' ? 20 : 200);
  if (body.credit_limit !== undefined) {
    if (body.credit_limit !== null && !isMoney(body.credit_limit))
      throw badRequest('Invalid credit_limit');
    patch.credit_limit = body.credit_limit;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean')
      throw badRequest('Invalid archived');
    patch.archived = body.archived;
  }
  Object.assign(c, patch, { updated_at: nowIso() });
  return c;
}

export function listCustomers(query: URLSearchParams): Customer[] {
  const sort = query.get('sort') ?? 'balance';
  if (!['balance', 'recent', 'name'].includes(sort))
    throw badRequest('Invalid sort');
  for (const field of ['archived', 'overdue'])
    if (query.has(field) && !['true', 'false'].includes(query.get(field)!))
      throw badRequest(`Invalid ${field}`);
  const needle = (query.get('query') ?? '').toLowerCase();
  return getMockDb()
    .customers.map((c) => getCustomer(c.id))
    .filter((c) => c.archived === (query.get('archived') === 'true'))
    .filter(
      (c) =>
        !query.has('overdue') ||
        c.overdue === (query.get('overdue') === 'true'),
    )
    .filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        (c.phone ?? '').toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        (sort === 'name'
          ? a.name.localeCompare(b.name)
          : sort === 'recent'
            ? b.updated_at.localeCompare(a.updated_at)
            : b.balance - a.balance) || b.id.localeCompare(a.id),
    );
}

export function recordEntry(
  input: Pick<DebtEntry, 'customer_id' | 'kind' | 'amount'> &
    Partial<Pick<DebtEntry, 'sale_id' | 'method' | 'reason'>>,
  at = nowIso(),
): DebtEntry {
  const customer = getCustomer(input.customer_id);
  customer.balance += input.amount;
  customer.updated_at = nowIso();
  const entry: DebtEntry = {
    id: newUuid(),
    sale_id: null,
    method: null,
    reason: null,
    ...input,
    balance_after: customer.balance,
    business_date: businessDate(at),
    created_at: nowIso(),
    member_id: getCurrentMember().id,
  };
  getMockDb().debtEntries.push(entry);
  getCustomer(customer.id);
  return entry;
}

export function validateSaleCredit(req: CreateSaleRequest): void {
  const credit = req.credit;
  if (req.payment_method === 'credit') {
    if (
      !credit ||
      credit.amount !== req.total ||
      req.cash_received !== undefined
    )
      throw badRequest(
        'Full credit requires total amount and no cash_received',
      );
  } else if (credit && !(credit.amount > 0 && credit.amount < req.total))
    throw badRequest('Partial credit must be between zero and total');
  if (credit) {
    if (!isMoney(credit.amount) || !isUuid(credit.customer_id))
      throw badRequest('Invalid credit');
    getCustomer(credit.customer_id);
  }
}

export function reverseSaleCredit(sale: Sale, at: string): void {
  if (sale.customer_id && sale.credit_amount > 0)
    recordEntry(
      {
        customer_id: sale.customer_id,
        amount: -sale.credit_amount,
        kind: 'void',
        sale_id: sale.id,
      },
      at,
    );
}

function writePayment(
  id: string,
  body: Record<string, unknown>,
  request: Request,
  adjustment: boolean,
) {
  if (adjustment) requireLead();
  const key = request.headers.get('Idempotency-Key');
  if (!key) throw unprocessableEntity('Idempotency-Key is required');
  const db = getMockDb();
  const cacheKey = `debt:${key}`;
  const hash = stable({ customer_id: id, adjustment, body: stable(body) });
  const previous = db.idempotency.get(cacheKey);
  if (previous) {
    if (previous.hash !== hash)
      throw conflict('id_conflict', 'Key reused with another operation');
    return { status: 200, body: previous.value };
  }
  getCustomer(id);
  if (
    !Number.isSafeInteger(body.amount) ||
    body.amount === 0 ||
    (!adjustment && !isMoney(body.amount))
  )
    throw unprocessableEntity('Invalid amount');
  let reason: string | null = null;
  if (adjustment) {
    if (
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 1 ||
      body.reason.length > 200
    )
      throw unprocessableEntity('Invalid reason');
    reason = body.reason;
  } else if (!['cash', 'transfer'].includes(String(body.method)))
    throw unprocessableEntity('Invalid method');
  const at = timestamp(body[adjustment ? 'adjusted_at' : 'paid_at']);
  const entry = recordEntry(
    {
      customer_id: id,
      kind: adjustment ? 'adjustment' : 'repayment',
      amount: (body.amount as number) * (adjustment ? 1 : -1),
      reason,
      method: adjustment ? null : (body.method as 'cash' | 'transfer'),
    },
    at,
  );
  db.idempotency.set(cacheKey, { hash, value: entry });
  return { status: 201, body: entry };
}

export function getDebtSummary(): DebtSummary {
  const debtors = getMockDb()
    .customers.map((c) => getCustomer(c.id))
    .filter((c) => c.balance > 0)
    .sort((a, b) => b.balance - a.balance);
  const overdue = debtors.filter((c) => c.overdue);
  return {
    total_outstanding: debtors.reduce((s, c) => s + c.balance, 0),
    customers_with_debt: debtors.length,
    overdue_count: overdue.length,
    overdue_amount: overdue.reduce((s, c) => s + c.balance, 0),
    top_debtors: debtors.slice(0, 5),
  };
}

async function read(request: Request) {
  try {
    return asObject(await request.json());
  } catch (error) {
    if (error instanceof MockHttpError) throw error;
    throw badRequest('Invalid JSON');
  }
}
export const DEBT_ROUTES: MockRoute[] = [
  {
    method: 'GET',
    path: '/v1/customers',
    handler: ({ query }) => ({
      status: 200,
      body: paginate(listCustomers(query), query),
    }),
  },
  {
    method: 'POST',
    path: '/v1/customers',
    handler: async ({ request }) => {
      const result = createCustomer(await read(request));
      return { status: result.created ? 201 : 200, body: result.customer };
    },
  },
  {
    method: 'GET',
    path: '/v1/customers/{customerId}',
    handler: ({ params }) => ({
      status: 200,
      body: getCustomer(params.customerId!),
    }),
  },
  {
    method: 'PATCH',
    path: '/v1/customers/{customerId}',
    handler: async ({ params, request }) => ({
      status: 200,
      body: updateCustomer(params.customerId!, await read(request)),
    }),
  },
  {
    method: 'GET',
    path: '/v1/customers/{customerId}/entries',
    handler: ({ params, query }) => {
      getCustomer(params.customerId!);
      return {
        status: 200,
        body: paginate(
          getMockDb()
            .debtEntries.filter((e) => e.customer_id === params.customerId)
            .sort(
              (a, b) =>
                b.created_at.localeCompare(a.created_at) ||
                b.id.localeCompare(a.id),
            ),
          query,
        ),
      };
    },
  },
  {
    method: 'POST',
    path: '/v1/customers/{customerId}/repayments',
    handler: async ({ params, request }) =>
      writePayment(params.customerId!, await read(request), request, false),
  },
  {
    method: 'POST',
    path: '/v1/customers/{customerId}/adjustments',
    handler: async ({ params, request }) =>
      writePayment(params.customerId!, await read(request), request, true),
  },
  {
    method: 'GET',
    path: '/v1/debts/summary',
    handler: () => ({ status: 200, body: getDebtSummary() }),
  },
];
