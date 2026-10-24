import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

import * as api from '../../src/lib/api';
import { newUuid } from '../../src/lib/uuid';
import { PRODUCT_IDS } from '../../src/test/mock/fixtures';
import { resetMockDb } from '../../src/test/mock/db';
import { MOCK_ROUTES } from '../../src/test/mock/routes';
import { setMockScenario } from '../../src/test/mock/scenario';

type Recorded = { method: string; path: string; status: number; body: unknown };
const recorded: Recorded[] = [];

jest.mock('../../src/test/mock/fetch', () => {
  const actual = jest.requireActual('../../src/test/mock/fetch');
  return {
    ...actual,
    createMockFetch: (options?: unknown) => {
      const mockFetch = actual.createMockFetch(options) as typeof fetch;
      return async (input: Request) => {
        const response = await mockFetch(input);
        const text = await response.clone().text();
        recorded.push({
          method: input.method,
          path: new URL(input.url).pathname,
          status: response.status,
          body: text ? JSON.parse(text) : undefined,
        });
        return response;
      };
    },
  };
});

// ---- load the spec ----------------------------------------------------------

type Json = Record<string, any>;
const spec: Json = parse(
  readFileSync(join(__dirname, '../../../../docs/api/openapi.yaml'), 'utf8'),
);
const ROOT = 'urn:taphoa:openapi';

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateSchema: false,
});
addFormats(ajv);
ajv.addSchema({ $id: ROOT, components: spec.components });

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string' && v.startsWith('#/')
          ? `${ROOT}${v}`
          : rewriteRefs(v),
      ]),
    );
  }
  return node;
}

const pointer = (ref: string): Json =>
  ref
    .replace(/^#\//, '')
    .split('/')
    .reduce(
      (node: Json, key) => node[key.replace(/~1/g, '/').replace(/~0/g, '~')],
      spec,
    );

function findOperation(method: string, path: string) {
  for (const [template, item] of Object.entries<Json>(spec.paths)) {
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    const op = item[method.toLowerCase()];
    if (pattern.test(path) && op) return { template, op: op as Json };
  }
  return null;
}

function responseSchema(op: Json, status: number): Json | undefined {
  const entry = op.responses[String(status)];
  if (!entry) return undefined;
  const response = entry.$ref ? pointer(entry.$ref) : entry;
  return response.content?.['application/json']?.schema;
}

function validate(entry: Recorded) {
  const found = findOperation(entry.method, entry.path);
  if (!found)
    throw new Error(
      `mock served ${entry.method} ${entry.path}, which is not in the spec`,
    );
  expect(Object.keys(found.op.responses)).toContain(String(entry.status));
  const schema = responseSchema(found.op, entry.status);
  if (!schema) {
    expect(entry.body).toBeUndefined();
    return found.template;
  }
  for (const extra of extraProperties(schema, entry.body, '$')) {
    extraSeen.add(extra.replace(/\[\]/g, ''));
  }
  const check = ajv.compile(rewriteRefs(schema) as object);
  const valid = check(entry.body);
  if (!valid) {
    throw new Error(
      `${entry.method} ${found.template} ${entry.status} does not match the schema:\n` +
        JSON.stringify(check.errors, null, 1) +
        `\nbody: ${JSON.stringify(entry.body).slice(0, 500)}`,
    );
  }
  return found.template;
}

/** Leaf schemas (refs and allOf expanded) that all apply to one value. */
function expand(schema: Json): Json[] {
  if (schema.$ref) return expand(pointer(schema.$ref));
  if (schema.allOf) return (schema.allOf as Json[]).flatMap(expand);
  return [schema];
}

/**
 * Paths of properties the response carries that the schema does not declare.
 * `oneOf`/`anyOf` picks the branch with the fewest extras.
 */
function extraProperties(schema: Json, value: unknown, path: string): string[] {
  if (value === null || typeof value !== 'object') return [];
  const leaves = expand(schema);
  const branches = leaves.flatMap(
    (l) => [...(l.oneOf ?? []), ...(l.anyOf ?? [])] as Json[],
  );
  const extras: string[] = [];
  if (Array.isArray(value)) {
    for (const leaf of leaves) {
      if (leaf.items)
        value.forEach((item) =>
          extras.push(...extraProperties(leaf.items, item, `${path}[]`)),
        );
    }
    return extras;
  }
  const declared = leaves.filter((l) => l.properties);
  for (const [key, child] of Object.entries(value as Json)) {
    const sub = declared
      .map((l) => l.properties[key])
      .filter(Boolean) as Json[];
    if (sub.length === 0) {
      if (declared.length > 0) extras.push(`${path}.${key}`);
      continue;
    }
    extras.push(
      ...sub.flatMap((sc) => extraProperties(sc, child, `${path}.${key}`)),
    );
  }
  if (branches.length > 0) {
    const best = branches
      .map((b) => extraProperties(b, value, path))
      .sort((a, b) => a.length - b.length)[0]!;
    extras.push(...best);
  }
  return extras;
}

const extraSeen = new Set<string>();

// ---- harness ----------------------------------------------------------------

const covered = new Set<string>();

/** Runs a typed API call, validates the response the mock produced and returns the outcome. */
async function call<T>(fn: () => Promise<T>, expectedStatus?: number) {
  const before = recorded.length;
  let data: T | undefined;
  let error: unknown;
  try {
    data = await fn();
  } catch (e) {
    error = e;
  }
  const entries = recorded.slice(before);
  expect(entries.length).toBeGreaterThan(0);
  const last = entries[entries.length - 1]!;
  const template = validate(last);
  covered.add(`${last.method} ${template}`);
  if (expectedStatus !== undefined) expect(last.status).toBe(expectedStatus);
  return { data: data as T, error, status: last.status };
}

const jpeg = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
const lineFor = (productId: string, quantity: number, unitPrice: number) => ({
  id: newUuid(),
  product_id: productId,
  source: 'camera' as const,
  quantity,
  unit_price: unitPrice,
});
const today = () => api.getTodayReport().then((r) => r.business_date);

beforeEach(() => {
  resetMockDb();
  api.resetApiClient();
});

// ---- tests ------------------------------------------------------------------

test('every mocked route exists in docs/api/openapi.yaml', () => {
  for (const route of MOCK_ROUTES) {
    const item = spec.paths[route.path];
    expect(item?.[route.method.toLowerCase()]).toBeDefined();
  }
});

describe('success responses match the documented schema', () => {
  test('health, identity, store, members, invites', async () => {
    await call(() => api.getHealth(), 200);
    await call(() => api.getMe(), 200);
    await call(() => api.getStore(), 200);
    await call(
      () => api.patchStore({ margin_threshold_pct: 12, bank_account: null }),
      200,
    );
    await call(
      () =>
        api.patchStore({ name: 'Tạp hóa Cô Ba 2', sales_memo_prefix: 'TB' }),
      200,
    );
    await call(() => api.listMembers(), 200);
    await call(
      () =>
        api.createInvite({
          role: 'seller',
          can_enroll: true,
          ttl_seconds: 900,
        }),
      201,
    );
  });

  test('images and scans (single, multi, unknown, ambiguous, by image id)', async () => {
    const up = await call(() => api.uploadImage(jpeg(), 'enrollment'), 201);
    expect(up.data.content_type).toBe('image/jpeg');

    for (const scenario of [
      'auto',
      'match',
      'multi',
      'unknown',
      'ambiguous',
    ] as const) {
      setMockScenario(scenario);
      const single = await call(
        () => api.createScan({ image: jpeg(), mode: 'single' }),
        201,
      );
      expect(single.data.detections.length).toBeGreaterThan(0);
      await call(
        () => api.createScan({ image: jpeg(), mode: 'multi', top_k: 3 }),
        201,
      );
    }
    setMockScenario('auto');
    await call(
      () => api.createScan({ image: jpeg(), purpose: 'enrollment' }),
      201,
    );
    const byId = await call(
      () => api.createScan({ image_id: up.data.id }),
      201,
    );
    expect(byId.data.image.id).toBe(up.data.id);
  });

  test('catalog: list, search, get, create, patch, add image, categories', async () => {
    const list = await call(() => api.listProducts({ limit: 5 }), 200);
    expect(list.data.items).toHaveLength(5);
    expect(list.data.next_cursor).not.toBeNull();
    await call(
      () => api.listProducts({ cursor: list.data.next_cursor, limit: 5 }),
      200,
    );
    const search = await call(() => api.listProducts({ q: 'hao hao' }), 200);
    expect(search.data.items.map((p) => p.name)).toEqual([
      'Mì Hảo Hảo tôm chua cay',
    ]);
    await call(() => api.getProduct(PRODUCT_IDS.coca), 200);
    await call(() => api.listCategories(), 200);

    const image = await api.uploadImage(jpeg(), 'enrollment');
    const id = newUuid();
    const create = await call(
      () =>
        api.createProduct({
          id,
          price: 15000,
          image_ids: [image.id],
          name: 'Sting đỏ 330ml',
          base_unit: 'chai',
          cost_price: 12000,
          force_new: false,
        }),
      201,
    );
    expect(create.data.images).toHaveLength(1);
    await call(
      () =>
        api.createProduct({
          id,
          price: 15000,
          image_ids: [image.id],
          force_new: false,
        }),
      200,
    );
    await call(
      () =>
        api.patchProduct(id, { price: 16000, name: null, cost_price: null }),
      200,
    );
    const second = await api.uploadImage(jpeg());
    await call(() => api.addProductImage(id, { image_id: second.id }), 201);
  });

  test('sales, expenses, alerts, reports and day close', async () => {
    const date = await today();
    const saleId = newUuid();
    const sale = {
      id: saleId,
      sold_at: new Date().toISOString(),
      payment_method: 'cash' as const,
      cash_received: 50000,
      total: 29000,
      lines: [
        lineFor(PRODUCT_IDS.coca, 2, 10000),
        lineFor(PRODUCT_IDS.pepsi, 1, 9000),
      ],
    };
    await call(() => api.createSale(sale), 201);
    await call(() => api.createSale(sale), 200);
    await call(
      () =>
        api.createSale({
          id: newUuid(),
          sold_at: new Date().toISOString(),
          payment_method: 'transfer',
          total: 4500,
          lines: [lineFor(PRODUCT_IDS.haohao, 1, 4500)],
        }),
      201,
    );
    await call(
      () =>
        api.listSales({
          from: date,
          to: date,
          payment_method: 'cash',
          limit: 10,
        }),
      200,
    );

    await call(
      () =>
        api.createExpense({
          id: newUuid(),
          spent_at: new Date().toISOString(),
          amount: 400000,
          category: 'nhap_hang',
          paid_with: 'cash_box',
          purchase_lines: [
            { product_id: PRODUCT_IDS.coca, quantity: 24, unit_cost: 9500 },
          ],
        }),
      201,
    );
    await call(
      () => api.listExpenses({ from: date, to: date, category: 'nhap_hang' }),
      200,
    );

    const alerts = await call(() => api.listAlerts(), 200);
    expect(alerts.data.length).toBeGreaterThanOrEqual(2);
    await call(() => api.listAlerts('dismissed'), 200);
    await call(() => api.acceptAlert(alerts.data[0]!.id, 12000), 200);
    await call(() => api.dismissAlert(alerts.data[1]!.id), 200);

    const report = await call(() => api.getTodayReport(), 200);
    expect(report.data.revenue).toBeGreaterThanOrEqual(33500);
    await call(() => api.getTodayReport(date), 200);
    for (const granularity of ['day', 'week', 'month'] as const) {
      await call(
        () =>
          api.getReportSummary({ from: '2026-08-01', to: date, granularity }),
        200,
      );
    }
    await call(() => api.getDayClose('2000-01-01'), 404);
    const close = await call(
      () =>
        api.createDayClose(date, {
          counted_cash: 100000,
          opening_float: 20000,
          note: 'ok',
        }),
      200,
    );
    expect(close.data.difference).toBe(
      close.data.counted_cash - close.data.expected_cash,
    );
    await call(() => api.getDayClose(date), 200);
  });
});

describe('error responses match the Error schema', () => {
  test('404s', async () => {
    const missing = newUuid();
    expect(
      (await call(() => api.getProduct(missing), 404)).error,
    ).toBeInstanceOf(api.ApiError);
    await call(() => api.patchProduct(missing, { price: 1 }), 404);
    await call(
      () => api.addProductImage(missing, { image_id: newUuid() }),
      404,
    );
    await call(() => api.acceptAlert(missing), 404);
    await call(() => api.dismissAlert(missing), 404);
    await call(() => api.getDayClose('2001-01-01'), 404);
  });

  test('400 validation, total_mismatch and unknown references', async () => {
    const bad = await call(
      () =>
        api.createSale({
          ...{
            id: newUuid(),
            sold_at: new Date().toISOString(),
            payment_method: 'cash',
            total: 1,
            lines: [lineFor(PRODUCT_IDS.coca, 1, 10000)],
          },
        }),
      400,
    );
    expect((bad.error as InstanceType<typeof api.ApiError>).code).toBe(
      'total_mismatch',
    );
    await call(
      () =>
        api.createSale({
          id: 'nope',
          sold_at: 'x',
          payment_method: 'cash',
          total: 0,
          lines: [],
        }),
      400,
    );
    await call(
      () =>
        api.createSale({
          id: newUuid(),
          sold_at: new Date().toISOString(),
          payment_method: 'cash',
          total: 100,
          lines: [lineFor(newUuid(), 1, 100)],
        }),
      400,
    );
    await call(
      () =>
        api.createProduct({
          id: newUuid(),
          price: 1,
          image_ids: [newUuid()],
          force_new: false,
        }),
      400,
    );
    await call(
      () =>
        api.createExpense({
          id: newUuid(),
          spent_at: 'yesterday',
          amount: -1,
          category: 'khac',
          paid_with: 'other',
        }),
      400,
    );
    await call(
      () => api.createDayClose('2026-10-23', { counted_cash: -5 }),
      400,
    );
    await call(
      () => api.getReportSummary({ from: '2026-10-23', to: '2026-10-01' }),
      400,
    );
    await call(() => api.patchStore({ margin_threshold_pct: 500 }), 400);
    await call(() => api.createScan({ image: jpeg(), top_k: 9 }), 400);
    await call(() => api.uploadImage(jpeg(), 'nonsense' as never), 400);
  });

  test('409 alert_closed and image_limit, 415 media type', async () => {
    const [alert] = await api.listAlerts();
    await api.dismissAlert(alert!.id);
    const accept = await call(() => api.acceptAlert(alert!.id), 409);
    expect((accept.error as InstanceType<typeof api.ApiError>).code).toBe(
      'alert_closed',
    );

    const id = PRODUCT_IDS.coca; // seeded with 2 images
    for (let i = 0; i < 3; i += 1) {
      const image = await api.uploadImage(jpeg());
      await call(() => api.addProductImage(id, { image_id: image.id }), 201);
    }
    const extra = await api.uploadImage(jpeg());
    const full = await call(
      () => api.addProductImage(id, { image_id: extra.id }),
      409,
    );
    expect((full.error as InstanceType<typeof api.ApiError>).code).toBe(
      'image_limit',
    );

    await call(
      () => api.uploadImage(new Blob(['x'], { type: 'text/plain' })),
      415,
    );
    await call(
      () =>
        api.createScan({ image: new Blob(['x'], { type: 'application/pdf' }) }),
      415,
    );
  });
});

describe('manual lines (sold without catalog)', () => {
  test('list, create through a manual sale line, resolve', async () => {
    const open = await call(() => api.listManualLines(), 200);
    expect(open.data.items).toHaveLength(3);
    await call(
      () => api.listManualLines({ status: 'resolved', limit: 5 }),
      200,
    );
    await call(() => api.listManualLines({ limit: 2 }), 200);

    const lineId = newUuid();
    await call(
      () =>
        api.createSale({
          id: newUuid(),
          sold_at: new Date().toISOString(),
          payment_method: 'cash',
          total: 7000,
          lines: [
            {
              id: lineId,
              product_id: null,
              source: 'manual',
              quantity: 1,
              unit_price: 7000,
              manual_label: 'Hành lá',
            },
          ],
        }),
      201,
    );
    const after = await call(() => api.listManualLines(), 200);
    expect(after.data.items).toHaveLength(4);
    expect(after.data.items.find((l) => l.line_id === lineId)).toMatchObject({
      manual_label: 'Hành lá',
      reason: 'manual_price',
      status: 'open',
    });

    const [a, b, c] = open.data.items;
    const linked = await call(
      () =>
        api.resolveManualLine(a!.line_id, {
          action: 'link',
          product_id: PRODUCT_IDS.coca,
        }),
      200,
    );
    expect(linked.data.resolution).toMatchObject({
      action: 'link',
      product_id: PRODUCT_IDS.coca,
    });
    await call(
      () =>
        api.resolveManualLine(b!.line_id, {
          action: 'enrolled',
          product_id: PRODUCT_IDS.pepsi,
        }),
      200,
    );
    const dismissed = await call(
      () => api.resolveManualLine(c!.line_id, { action: 'dismiss' }),
      200,
    );
    expect(dismissed.data.resolution?.product_id).toBeNull();
    expect(
      (await call(() => api.listManualLines({ status: 'resolved' }), 200)).data
        .items,
    ).toHaveLength(3);
  });

  test('errors: 404 unknown line, 400 invalid action / missing product', async () => {
    await call(
      () => api.resolveManualLine(newUuid(), { action: 'dismiss' }),
      404,
    );
    const [line] = (await api.listManualLines()).items;
    await call(
      () => api.resolveManualLine(line!.line_id, { action: 'nope' as never }),
      400,
    );
    await call(
      () => api.resolveManualLine(line!.line_id, { action: 'link' }),
      400,
    );
  });
});

test('the contract suite called every mocked operation', () => {
  const missing = MOCK_ROUTES.map((r) => `${r.method} ${r.path}`).filter(
    (key) => !covered.has(key),
  );
  expect(missing).toEqual([]);
});
