import {
  mockMe,
  mockCreateStore,
  mockJoinStore,
  mockSetPin,
  mockVerifyPin,
} from './auth';
import { businessDate } from '@/lib/date';
import type {
  AlertStatus,
  Image,
  ImagePurpose,
  ManualLineStatus,
  ScanMode,
  ScanPurpose,
  SummaryGranularity,
} from '@/lib/api/types';

import * as db from './db';
import { badRequest, MockHttpError } from './errors';
import * as ledger from './ledger';
import * as stock from './stockReceipts';
import { readMultipart, type FormFields, type FormFile } from './multipart';
import { buildScan } from './scan';
import {
  asObject,
  isUuid,
  paginate,
  parseAccept,
  parseCreateExpense,
  parseCreateProduct,
  parseCreateSale,
  parseDate,
  parseDayClose,
  parseInvite,
  parseProductPatch,
  parseResolveManualLine,
  parseSegmentPoints,
  parseStorePatch,
} from './validate';

export type RouteContext = {
  request: Request;
  params: Record<string, string>;
  query: URLSearchParams;
};
export type RouteResult = { status: number; body?: unknown };
export type MockRoute = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI path template, e.g. `/v1/products/{productId}`. */
  path: string;
  handler: (ctx: RouteContext) => RouteResult | Promise<RouteResult>;
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Image['content_type'][] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
const IMAGE_PURPOSES: ImagePurpose[] = [
  'enrollment',
  'checkout',
  'expense_receipt',
  'other',
];

const ok = (body: unknown): RouteResult => ({ status: 200, body });
const created = (body: unknown): RouteResult => ({ status: 201, body });
const okOrCreated = (body: unknown, isNew: boolean): RouteResult => ({
  status: isNew ? 201 : 200,
  body,
});

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

function pickFile(fields: FormFields, key: string): FormFile | null {
  const value = fields.get(key);
  if (value === undefined) return null;
  if (typeof value === 'string')
    throw badRequest(`${key} must be a file part`, { field: key });
  return value;
}

function imageFromFile(file: FormFile, purpose: ImagePurpose): Image {
  const type = (file.type || 'image/jpeg') as Image['content_type'];
  if (!IMAGE_TYPES.includes(type)) {
    throw new MockHttpError(
      415,
      'unsupported_media_type',
      'Image type is not JPEG, PNG or WebP',
    );
  }
  if ((file.size ?? 0) > MAX_UPLOAD_BYTES) {
    throw new MockHttpError(413, 'payload_too_large', 'Upload above 10 MiB');
  }
  return db.registerImage({
    contentType: type,
    byteSize: file.size ?? 1,
    purpose,
    uri: file.uri,
    name: file.name,
  });
}

function stringField<T extends string>(
  fields: FormFields,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = fields.get(key);
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${key} must be one of ${allowed.join(', ')}`, {
      field: key,
    });
  }
  return value as T;
}

async function createScanHandler({
  request,
}: RouteContext): Promise<RouteResult> {
  const fields = await readMultipart(request);
  const mode = stringField<ScanMode>(
    fields,
    'mode',
    ['single', 'multi'],
    'multi',
  );
  const purpose = stringField<ScanPurpose>(
    fields,
    'purpose',
    ['checkout', 'enrollment'],
    'checkout',
  );
  const rawTopK = fields.get('top_k');
  const topK = rawTopK === undefined ? 4 : Number(rawTopK);
  if (!Number.isInteger(topK) || topK < 1 || topK > 5) {
    throw badRequest('top_k must be an integer 1–5', { field: 'top_k' });
  }

  const file = pickFile(fields, 'image');
  const imageId = fields.get('image_id');
  let image: Image;
  if (file) {
    image = imageFromFile(file, purpose);
  } else if (typeof imageId === 'string' && isUuid(imageId)) {
    const known = db.getMockDb().images.get(imageId);
    if (!known)
      throw badRequest(
        `image ${imageId} does not exist`,
        { field: 'image_id' },
        'unknown_image',
      );
    image = known;
  } else {
    throw badRequest('image or image_id is required', { field: 'image' });
  }
  return created(buildScan({ image, mode, purpose, topK }));
}

async function uploadImageHandler({
  request,
}: RouteContext): Promise<RouteResult> {
  const fields = await readMultipart(request);
  const file = pickFile(fields, 'image');
  if (!file) throw badRequest('image is required', { field: 'image' });
  const storeId = fields.get('store_id');
  if (storeId !== undefined && storeId !== db.getStore().id) {
    throw badRequest('unknown store', { field: 'store_id' });
  }
  const purpose = stringField<ImagePurpose>(
    fields,
    'purpose',
    IMAGE_PURPOSES,
    'other',
  );
  return created(imageFromFile(file, purpose));
}

const requireDate = (query: URLSearchParams, key: string): string => {
  const value = query.get(key);
  if (value === null) throw badRequest(`${key} is required`, { field: key });
  return parseDate(value, key);
};
const optionalDate = (query: URLSearchParams, key: string): string | null => {
  const value = query.get(key);
  return value === null ? null : parseDate(value, key);
};

export const MOCK_ROUTES: MockRoute[] = [
  {
    method: 'POST',
    path: '/v1/stores',
    handler: async ({ request }) =>
      created(mockCreateStore(request, await readJson(request))),
  },
  {
    method: 'POST',
    path: '/v1/auth/join',
    handler: async ({ request }) =>
      created(mockJoinStore(request, await readJson(request))),
  },
  {
    method: 'PUT',
    path: '/v1/me/pin',
    handler: async ({ request }) => {
      mockSetPin(request, await readJson(request));
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    path: '/v1/me/pin/verify',
    handler: async ({ request }) => {
      mockVerifyPin(request, await readJson(request));
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: '/v1/stock',
    handler: ({ query }) =>
      ok(paginate(stock.listStock(query.get('status') ?? 'all'), query)),
  },
  {
    method: 'GET',
    path: '/v1/products/{productId}/stock-movements',
    handler: ({ params, query }) =>
      ok(paginate(stock.listStockMovements(params.productId!), query)),
  },
  {
    method: 'POST',
    path: '/v1/products/{productId}/stock-adjustments',
    handler: async ({ params, request }) => {
      const body = asObject(await readJson(request));
      return ok(
        stock.idempotent(`adjust:${params.productId}`, request, body, () =>
          stock.adjustStock(params.productId!, body),
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/v1/receipts',
    handler: ({ query }) =>
      ok(paginate(stock.listReceipts(query.get('status')), query)),
  },
  {
    method: 'POST',
    path: '/v1/receipts',
    handler: async ({ request }) => {
      const body = asObject(await readJson(request));
      return created(
        stock.idempotent('receipt', request, body, () =>
          stock.createReceipt(body.image_id),
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/v1/receipts/{receiptId}',
    handler: ({ params }) => ok(stock.getReceipt(params.receiptId!)),
  },
  {
    method: 'POST',
    path: '/v1/receipts/{receiptId}/confirm',
    handler: async ({ params, request }) => {
      const body = asObject(await readJson(request));
      return ok(
        stock.idempotent(`confirm:${params.receiptId}`, request, body, () =>
          stock.confirmReceipt(
            params.receiptId!,
            body as unknown as import('@/lib/api/types').ReceiptConfirm,
          ),
        ),
      );
    },
  },
  {
    method: 'DELETE',
    path: '/v1/receipts/{receiptId}',
    handler: ({ params }) => {
      stock.discardReceipt(params.receiptId!);
      return { status: 204 };
    },
  },

  { method: 'GET', path: '/healthz', handler: () => ok({ status: 'ok' }) },
  {
    method: 'GET',
    path: '/v1/me',
    handler: ({ request }) => ok(mockMe(request)),
  },
  { method: 'GET', path: '/v1/store', handler: () => ok(db.getStore()) },
  {
    method: 'PATCH',
    path: '/v1/store',
    handler: async ({ request }) =>
      ok(db.patchStore(parseStorePatch(await readJson(request)))),
  },
  {
    method: 'GET',
    path: '/v1/members',
    handler: () => ok({ items: db.getMockDb().members }),
  },
  {
    method: 'POST',
    path: '/v1/invites',
    handler: async ({ request }) =>
      created(db.createInvite(parseInvite(await readJson(request)))),
  },
  { method: 'POST', path: '/v1/images', handler: uploadImageHandler },
  { method: 'POST', path: '/v1/recognition/scans', handler: createScanHandler },
  {
    method: 'POST',
    path: '/v1/segment/points',
    handler: async ({ request }) =>
      ok(db.segmentPoints(parseSegmentPoints(await readJson(request)))),
  },
  {
    method: 'GET',
    path: '/v1/products',
    handler: ({ query }) => {
      const products = db.listProducts({
        q: query.get('q'),
        barcode: query.get('barcode'),
        categoryId: query.get('category_id'),
        includeArchived: query.get('include_archived') === 'true',
      });
      return ok(paginate(products, query));
    },
  },
  {
    method: 'POST',
    path: '/v1/products',
    handler: async ({ request }) => {
      const result = db.createProduct(
        parseCreateProduct(await readJson(request)),
      );
      return okOrCreated(result.product, result.created);
    },
  },
  {
    method: 'GET',
    path: '/v1/products/{productId}',
    handler: ({ params }) => ok(db.getProduct(params.productId!)),
  },
  {
    method: 'PATCH',
    path: '/v1/products/{productId}',
    handler: async ({ params, request }) =>
      ok(
        db.patchProduct(
          params.productId!,
          parseProductPatch(await readJson(request)),
        ),
      ),
  },
  {
    method: 'POST',
    path: '/v1/products/{productId}/images',
    handler: async ({ params, request }) => {
      const body = asObject(await readJson(request));
      if (!isUuid(body.image_id))
        throw badRequest('image_id must be a UUID', { field: 'image_id' });
      return created(db.addProductImage(params.productId!, body.image_id));
    },
  },
  {
    method: 'GET',
    path: '/v1/categories',
    handler: () => ok({ items: db.getMockDb().categories }),
  },
  {
    method: 'GET',
    path: '/v1/sales',
    handler: ({ query }) =>
      ok(
        paginate(
          ledger.listSales({
            from: optionalDate(query, 'from'),
            to: optionalDate(query, 'to'),
            memberId: query.get('member_id'),
            paymentMethod: query.get('payment_method'),
            status: query.get('status'),
          }),
          query,
        ),
      ),
  },
  {
    method: 'POST',
    path: '/v1/sales',
    handler: async ({ request }) => {
      const result = ledger.createSale(
        parseCreateSale(await readJson(request)),
      );
      return okOrCreated(result.sale, result.created);
    },
  },
  {
    method: 'GET',
    path: '/v1/expenses',
    handler: ({ query }) =>
      ok(
        paginate(
          ledger.listExpenses({
            from: optionalDate(query, 'from'),
            to: optionalDate(query, 'to'),
            category: query.get('category'),
          }),
          query,
        ),
      ),
  },
  {
    method: 'POST',
    path: '/v1/expenses',
    handler: async ({ request }) => {
      const result = ledger.createExpense(
        parseCreateExpense(await readJson(request)),
      );
      return okOrCreated(result.expense, result.created);
    },
  },
  {
    method: 'GET',
    path: '/v1/alerts',
    handler: ({ query }) => {
      const status = (query.get('status') ?? 'open') as AlertStatus;
      if (!['open', 'accepted', 'dismissed'].includes(status)) {
        throw badRequest('status must be open, accepted or dismissed', {
          field: 'status',
        });
      }
      return ok({ items: db.listAlerts(status) });
    },
  },
  {
    method: 'GET',
    path: '/v1/review/manual-lines',
    handler: ({ query }) => {
      const status = (query.get('status') ?? 'open') as ManualLineStatus;
      if (!['open', 'resolved'].includes(status)) {
        throw badRequest('status must be open or resolved', {
          field: 'status',
        });
      }
      return ok(paginate(db.listManualLines(status), query));
    },
  },
  {
    method: 'POST',
    path: '/v1/review/manual-lines/{lineId}/resolve',
    handler: async ({ params, request }) =>
      ok(
        db.resolveManualLine(
          params.lineId!,
          parseResolveManualLine(await readJson(request)),
        ),
      ),
  },
  {
    method: 'POST',
    path: '/v1/alerts/{alertId}/accept',
    handler: async ({ params, request }) =>
      ok(
        db.acceptAlert(
          params.alertId!,
          parseAccept(await readJson(request)).new_price,
        ),
      ),
  },
  {
    method: 'POST',
    path: '/v1/alerts/{alertId}/dismiss',
    handler: ({ params }) => ok(db.dismissAlert(params.alertId!)),
  },
  {
    method: 'GET',
    path: '/v1/reports/today',
    handler: ({ query }) =>
      ok(ledger.getDailyReport(optionalDate(query, 'date') ?? businessDate())),
  },
  {
    method: 'GET',
    path: '/v1/reports/summary',
    handler: ({ query }) => {
      const granularity = (query.get('granularity') ??
        'day') as SummaryGranularity;
      if (!['day', 'week', 'month'].includes(granularity)) {
        throw badRequest('granularity must be day, week or month', {
          field: 'granularity',
        });
      }
      return ok(
        ledger.getSummaryReport(
          requireDate(query, 'from'),
          requireDate(query, 'to'),
          granularity,
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/v1/day-closes/{businessDate}',
    handler: ({ params }) =>
      ok(ledger.getDayClose(parseDate(params.businessDate!, 'businessDate'))),
  },
  {
    method: 'PUT',
    path: '/v1/day-closes/{businessDate}',
    handler: async ({ params, request }) =>
      ok(
        ledger.putDayClose(
          parseDate(params.businessDate!, 'businessDate'),
          parseDayClose(await readJson(request)),
        ),
      ),
  },
];
