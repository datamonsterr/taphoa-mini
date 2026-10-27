import { createApiClient } from '@taphoa/api-client';
import { createMockFetch } from '../../src/test/mock/fetch';
import {
  proposalReply,
  setNextAssistantReply,
} from '../../src/test/mock/assistant';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

import * as api from '../../src/lib/api';
import { newUuid } from '../../src/lib/uuid';
import { PRODUCT_IDS } from '../../src/test/mock/fixtures';
import { getMockDb, resetMockDb } from '../../src/test/mock/db';
import { MOCK_ROUTES } from '../../src/test/mock/routes';
import { setMockScenario } from '../../src/test/mock/scenario';

type Recorded = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  stream?: boolean;
};
const recorded: Recorded[] = [];

jest.mock('../../src/test/mock/fetch', () => {
  const actual = jest.requireActual('../../src/test/mock/fetch');
  return {
    ...actual,
    createMockFetch: (options?: unknown) => {
      const mockFetch = actual.createMockFetch(options) as typeof fetch;
      return async (input: Request) => {
        const response = await mockFetch(input);
        const stream =
          response.headers.get('content-type') === 'text/event-stream';
        const text = await response.clone().text();
        let body: unknown;
        if (stream) {
          const { readAssistantStream } =
            jest.requireActual('@taphoa/api-client');
          const events = [];
          const iterator = readAssistantStream(new Response(text).body!);
          let next = await iterator.next();
          while (!next.done) {
            events.push(next.value);
            next = await iterator.next();
          }
          body = events;
        } else {
          body = text ? JSON.parse(text) : undefined;
        }
        recorded.push({
          method: input.method,
          path: new URL(input.url).pathname,
          status: response.status,
          body,
          stream,
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
  const schema = entry.stream
    ? {
        type: 'array',
        items:
          found.op.responses[String(entry.status)].content['text/event-stream']
            .schema,
      }
    : responseSchema(found.op, entry.status);
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

  test('Clerk store creation, joining and PIN verification', async () => {
    getMockDb().hasMembership = false;
    await call(
      () => api.createStore({ store_name: 'Tạp hóa Mẹ', display_name: 'Mẹ' }),
      201,
    );
    await call(() => api.setPin('1234'), 204);
    await call(
      () =>
        api
          .getApiClient()
          .raw.POST('/v1/me/pin/verify', { body: { pin: '1234' } }),
      204,
    );
    getMockDb().hasMembership = false;
    await call(
      () =>
        api.joinStore({
          invite_token: 'K7Q4MZ2P9HXDT3VA',
          display_name: 'Bà nội',
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

    const seg = await call(
      () =>
        api.segmentPoints({
          image_id: up.data.id,
          points: [{ x: 100, y: 100, label: 1 }],
        }),
      200,
    );
    expect(seg.data.cutout_image_id).toBeDefined();
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

describe('stock and receipts', () => {
  test('tracked stock filters, adjustments, movements and thresholds', async () => {
    const page = await call(() => api.listStock({ limit: 1 }), 200);
    expect(page.data.items).toHaveLength(1);
    expect(page.data.items[0]!.status).toBe('out');
    expect(page.data.next_cursor).not.toBeNull();
    await call(
      () => api.listStock({ cursor: page.data.next_cursor, limit: 1 }),
      200,
    );
    const low = await call(() => api.listStock({ status: 'low' }), 200);
    expect(low.data.items.some((p) => p.status === 'low')).toBe(true);
    await call(() => api.listStock({ status: 'out' }), 200);
    await call(() => api.patchStore({ low_stock_threshold: 8 }), 200);
    await call(
      () => api.patchProduct(PRODUCT_IDS.coca, { low_stock_threshold: 3 }),
      200,
    );
    expect((await api.getProduct(PRODUCT_IDS.coca)).low_stock_threshold).toBe(
      3,
    );
    const key = newUuid();
    const adjusted = await call(
      () =>
        api.adjustStock(PRODUCT_IDS.coca, { count: 10, note: 'Count' }, key),
      200,
    );
    const replay = await call(
      () =>
        api.adjustStock(PRODUCT_IDS.coca, { count: 10, note: 'Count' }, key),
      200,
    );
    expect(replay.data.id).toBe(adjusted.data.id);
    const movements = await call(
      () => api.listStockMovements(PRODUCT_IDS.coca),
      200,
    );
    expect(movements.data.items[0]).toMatchObject({
      quantity_after: 10,
      reason: 'adjustment',
    });
    await call(
      () => api.adjustStock(PRODUCT_IDS.coca, { count: 1, delta: 1 }),
      422,
    );
    await call(() => api.listStockMovements(newUuid()), 404);
  });

  test('draft fixture, confirm exactly once into stock and expense, history and discard', async () => {
    const image = await api.uploadImage(jpeg(), 'expense_receipt');
    const key = newUuid();
    const draft = (
      await call(() => api.createReceipt({ image_id: image.id }, key), 201)
    ).data;
    expect(
      draft.lines.map((l) => [l.product_name, l.quantity, l.cost]),
    ).toEqual([
      ['Coca-Cola lon 330ml', 24, 204000],
      ['Mì Hảo Hảo tôm chua cay', 30, 126000],
      ['Nước suối Aquafina 500ml', 12, 60000],
      ['Bánh Chocopie hộp', 5, 66000],
    ]);
    expect(draft.lines[3]).toMatchObject({ product_id: null });
    expect(draft.lines[3]!.candidates).toHaveLength(2);
    expect(
      (await call(() => api.createReceipt({ image_id: image.id }, key), 201))
        .data.id,
    ).toBe(draft.id);
    await call(() => api.getReceipt(draft.id), 200);
    await call(() => api.listReceipts({ status: 'draft', limit: 1 }), 200);
    const input = {
      lines: draft.lines.slice(0, 3).map((l) => ({
        line_id: l.id,
        product_id: l.product_id!,
        quantity: l.quantity,
        cost: l.cost,
      })),
      paid_with: 'cash_box' as const,
    };
    const confirmKey = newUuid();
    const confirmed = (
      await call(() => api.confirmReceipt(draft.id, input, confirmKey), 200)
    ).data;
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      total: 390000,
      expense_id: expect.any(String),
    });
    expect(
      (await call(() => api.confirmReceipt(draft.id, input, confirmKey), 200))
        .data.expense_id,
    ).toBe(confirmed.expense_id);
    expect(
      (await api.listExpenses()).items.filter(
        (e) => e.id === confirmed.expense_id,
      ),
    ).toHaveLength(1);
    expect(
      (await api.listStockMovements(PRODUCT_IDS.coca)).items[0],
    ).toMatchObject({ delta: 24, reason: 'receipt' });
    await call(() => api.confirmReceipt(draft.id, input), 409);
    await call(() => api.discardReceipt(draft.id), 409);
    const another = await api.createReceipt({ image_id: image.id });
    await call(
      () => api.confirmReceipt(another.id, { ...input, lines: [] }),
      422,
    );
    await call(() => api.discardReceipt(another.id), 204);
    expect((await api.getReceipt(another.id)).status).toBe('discarded');
    await call(() => api.createReceipt({ image_id: newUuid() }), 404);
    await call(() => api.getReceipt(newUuid()), 404);
  });
});

test('debt customers, credit sale, ledger writes, summary and void conform to the contract', async () => {
  const input = {
    id: newUuid(),
    name: 'Lan',
    phone: '0901234567',
    credit_limit: 5000,
  };
  const customer = (await call(() => api.createCustomer(input), 201)).data;
  await call(() => api.createCustomer(input), 200);
  await call(() => api.createCustomer({ ...input, name: 'Mai' }), 409);
  await call(
    () => api.listCustomers({ sort: 'recent', query: 'Lan', limit: 1 }),
    200,
  );
  await call(() => api.getCustomer(customer.id), 200);
  await call(() => api.getCustomer(newUuid()), 404);
  await call(
    () => api.updateCustomer(customer.id, { note: 'Ghi chú', phone: null }),
    200,
  );
  const sale = (
    await call(
      () =>
        api.createSale({
          id: newUuid(),
          sold_at: new Date().toISOString(),
          payment_method: 'credit',
          credit: { customer_id: customer.id, amount: 10000 },
          total: 10000,
          lines: [lineFor(PRODUCT_IDS.coca, 1, 10000)],
        }),
      201,
    )
  ).data;
  const repayment = { amount: 1000, method: 'cash' as const };
  const key = newUuid();
  await call(() => api.createRepayment(customer.id, repayment, key), 201);
  await call(() => api.createRepayment(customer.id, repayment, key), 200);
  await call(
    () => api.createRepayment(customer.id, { ...repayment, amount: 2000 }, key),
    409,
  );
  await call(() => api.createRepayment(customer.id, repayment, ''), 422);
  const adjustmentKey = newUuid();
  const adjustment = { amount: -500, reason: 'Sửa nợ' };
  await call(
    () => api.createDebtAdjustment(customer.id, adjustment, adjustmentKey),
    201,
  );
  await call(
    () => api.createDebtAdjustment(customer.id, adjustment, adjustmentKey),
    200,
  );
  await call(() => api.listDebtEntries(customer.id), 200);
  await call(() => api.getDebtSummary(), 200);
  await call(async () => {
    const result = await api
      .getApiClient()
      .raw.POST('/v1/sales/{saleId}/void', {
        params: { path: { saleId: sale.id } },
        body: { reason: 'Nhầm đơn' },
      });
    return result.data;
  }, 200);
});

describe('assistant and devices', () => {
  test('threads, streamed proposal, decisions, feedback, next steps, digest and device registration match schemas', async () => {
    const client = createApiClient({
      baseUrl: 'http://mock.local',
      fetch: createMockFetch(),
    });
    const created = await call(
      () =>
        client.raw.POST('/v1/assistant/threads', {
          body: { title: 'Nhập hàng', context: { screen: 'camera' } },
        }),
      201,
    );
    const threadId = created.data.data!.id;
    await call(() => client.raw.GET('/v1/assistant/threads'), 200);
    setNextAssistantReply(proposalReply());
    await call(
      () =>
        client.sendAssistantMessage(threadId, {
          content: 'Nhập thêm mì',
          language: 'vi',
        }),
      200,
    );
    const detail = await call(
      () =>
        client.raw.GET('/v1/assistant/threads/{threadId}', {
          params: { path: { threadId } },
        }),
      200,
    );
    const actionId = detail.data.data!.actions[0]!.id;
    const messageId = detail.data.data!.messages[1]!.id;
    await call(
      () =>
        client.raw.POST('/v1/assistant/actions/{actionId}/confirm', {
          params: {
            path: { actionId },
            header: { 'Idempotency-Key': 'assistant-contract' },
          },
        }),
      200,
    );
    await call(
      () =>
        client.raw.POST('/v1/assistant/actions/{actionId}/reject', {
          params: { path: { actionId } },
        }),
      409,
    );
    await call(
      () =>
        client.raw.POST('/v1/assistant/messages/{messageId}/feedback', {
          params: { path: { messageId } },
          body: { rating: 'up' },
        }),
      204,
    );
    await call(
      () =>
        client.raw.GET('/v1/assistant/next-steps', {
          params: { query: { screen: 'camera' } },
        }),
      200,
    );
    await call(() => client.raw.GET('/v1/assistant/digest'), 200);
    await call(
      () =>
        client.raw.GET('/v1/assistant/digest', {
          params: { query: { business_date: '2000-01-01' } },
        }),
      404,
    );
    await call(
      () =>
        client.raw.POST('/v1/devices', {
          body: {
            token: 'ExponentPushToken[contract]',
            platform: 'android',
            app_version: '1.0',
            language: 'vi',
          },
        }),
      200,
    );
    await call(
      () =>
        client.raw.DELETE('/v1/devices/{token}', {
          params: { path: { token: 'ExponentPushToken[contract]' } },
        }),
      204,
    );
    await call(
      () =>
        client.raw.DELETE('/v1/assistant/threads/{threadId}', {
          params: { path: { threadId } },
        }),
      204,
    );
  });
});

test('the contract suite called every mocked operation', () => {
  const missing = MOCK_ROUTES.map((r) => `${r.method} ${r.path}`).filter(
    (key) => !covered.has(key),
  );
  expect(missing).toEqual([]);
});
