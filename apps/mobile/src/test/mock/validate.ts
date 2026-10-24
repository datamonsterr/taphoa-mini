import { isDateString } from '@/lib/date';
import type {
  BankAccount,
  CreateExpenseRequest,
  CreateProductRequest,
  CreateSaleRequest,
  ProductPatch,
  ProductReference,
  ProductUnit,
  ResolveManualLineInput,
  Role,
  SaleLineInput,
  SegmentPointsRequest,
  StorePatch,
} from '@/lib/api/types';

import { badRequest, conflict, unprocessableEntity } from './errors';

type Obj = Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const fail = (field: string, message: string): never => {
  throw badRequest(`${field}: ${message}`, { field });
};

export function asObject(value: unknown, what = 'body'): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(what, 'must be a JSON object');
  }
  return value as Obj;
}

const has = (o: Obj, key: string) => o[key] !== undefined;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isMoney(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function uuid(o: Obj, key: string): string {
  const v = o[key];
  return isUuid(v) ? v : fail(key, 'must be a UUID');
}

function money(o: Obj, key: string): number {
  const v = o[key];
  return isMoney(v) ? v : fail(key, 'must be a non-negative integer (VND)');
}

function text(o: Obj, key: string, max: number, min = 0): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    return fail(key, `must be a string of ${min}–${max} characters`);
  }
  return v;
}

function oneOf<T extends string>(
  o: Obj,
  key: string,
  allowed: readonly T[],
): T {
  const v = o[key];
  return allowed.includes(v as T)
    ? (v as T)
    : fail(key, `must be one of ${allowed.join(', ')}`);
}

function dateTime(o: Obj, key: string): string {
  const v = o[key];
  return typeof v === 'string' &&
    DATE_TIME_RE.test(v) &&
    !Number.isNaN(Date.parse(v))
    ? v
    : fail(key, 'must be an RFC 3339 date-time');
}

function intIn(o: Obj, key: string, min: number, max: number): number {
  const v = o[key];
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    ? (v as number)
    : fail(key, `must be an integer ${min}–${max}`);
}

function bankAccount(value: unknown): BankAccount {
  const o = asObject(value, 'bank_account');
  const bin = text(o, 'bank_bin', 6, 6);
  if (!/^[0-9]{6}$/.test(bin)) fail('bank_bin', 'must be 6 digits');
  const number = text(o, 'account_number', 19, 4);
  if (!/^[0-9A-Za-z]{4,19}$/.test(number)) {
    fail('account_number', 'must be 4–19 letters or digits');
  }
  return {
    bank_bin: bin,
    ...(has(o, 'bank_short_name')
      ? { bank_short_name: text(o, 'bank_short_name', 40) }
      : {}),
    account_number: number,
    account_name: text(o, 'account_name', 50),
  };
}

export function parseStorePatch(body: unknown): StorePatch {
  const o = asObject(body);
  const patch: StorePatch = {};
  if (has(o, 'name')) patch.name = text(o, 'name', 80, 1);
  if (has(o, 'bank_account')) {
    patch.bank_account =
      o.bank_account === null ? null : bankAccount(o.bank_account);
  }
  if (has(o, 'margin_threshold_pct')) {
    const v = o.margin_threshold_pct;
    if (typeof v !== 'number' || v < 0 || v > 100) {
      fail('margin_threshold_pct', 'must be a number 0–100');
    }
    patch.margin_threshold_pct = v as number;
  }
  if (has(o, 'sales_memo_prefix')) {
    patch.sales_memo_prefix = text(o, 'sales_memo_prefix', 8);
  }
  return patch;
}

/** The spec documents no 400 for invites, so out-of-range input falls back to defaults. */
export function parseInvite(body: unknown): {
  role: Role;
  can_enroll: boolean;
  ttl_seconds: number;
} {
  const o = typeof body === 'object' && body !== null ? (body as Obj) : {};
  const role: Role = o.role === 'lead' ? 'lead' : 'seller';
  const ttl = Number.isInteger(o.ttl_seconds) ? (o.ttl_seconds as number) : 600;
  return {
    role,
    can_enroll: role === 'lead' || o.can_enroll === true,
    ttl_seconds: Math.min(86400, Math.max(60, ttl)),
  };
}

function unit(value: unknown): ProductUnit {
  const o = asObject(value, 'units[]');
  return {
    id: uuid(o, 'id'),
    name: text(o, 'name', 40, 1),
    quantity_in_base: intIn(o, 'quantity_in_base', 1, 1_000_000),
    price: money(o, 'price'),
    barcode:
      has(o, 'barcode') && o.barcode !== null ? text(o, 'barcode', 64) : null,
  };
}

function reference(value: unknown): ProductReference {
  const o = asObject(value, 'references[]');
  const bbox = o.bbox;
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    fail('bbox', 'must be an array of 4 numbers [x, y, width, height]');
  }
  return {
    image_id: uuid(o, 'image_id'),
    cutout_image_id: uuid(o, 'cutout_image_id'),
    bbox: bbox as number[],
  };
}

export function parseCreateProduct(body: unknown): CreateProductRequest {
  const o = asObject(body);
  const hasRefs = has(o, 'references');
  const hasImages = has(o, 'image_ids');

  let references: ProductReference[] | undefined;
  let imageIds: string[] | undefined;

  if (hasRefs) {
    const refs = o.references;
    if (!Array.isArray(refs)) {
      fail('references', 'must be an array');
    }
    const refsArray = refs as unknown[];
    if (refsArray.length < 3) {
      throw unprocessableEntity('references must have at least 3 items', {
        field: 'references',
      });
    }
    if (refsArray.length > 8) {
      throw conflict('image_limit', 'total images cannot exceed 8');
    }
    references = refsArray.map(reference);
  } else if (hasImages) {
    const rawImageIds = o.image_ids;
    if (
      !Array.isArray(rawImageIds) ||
      rawImageIds.length < 1 ||
      rawImageIds.length > 5 ||
      !rawImageIds.every(isUuid)
    ) {
      fail('image_ids', 'must be 1–5 UUIDs');
    }
    imageIds = rawImageIds as string[];
  } else {
    fail('references', 'must provide references (3..8) or image_ids (1..5)');
  }

  if (has(o, 'units') && !Array.isArray(o.units))
    fail('units', 'must be an array');
  return {
    id: uuid(o, 'id'),
    price: money(o, 'price'),
    ...(references ? { references } : {}),
    ...(imageIds ? { image_ids: imageIds } : {}),
    force_new: o.force_new === true,
    ...(has(o, 'name') ? { name: text(o, 'name', 120) } : {}),
    ...(has(o, 'base_unit') ? { base_unit: text(o, 'base_unit', 20, 1) } : {}),
    ...(has(o, 'cost_price') ? { cost_price: money(o, 'cost_price') } : {}),
    ...(has(o, 'barcode') ? { barcode: text(o, 'barcode', 64) } : {}),
    ...(has(o, 'category_id') ? { category_id: uuid(o, 'category_id') } : {}),
    ...(has(o, 'from_manual_line_id')
      ? { from_manual_line_id: uuid(o, 'from_manual_line_id') }
      : {}),
    ...(has(o, 'units')
      ? {
          units: (o.units as unknown[]).map((raw) => {
            const { barcode, ...rest } = unit(raw);
            return barcode ? { ...rest, barcode } : rest;
          }),
        }
      : {}),
  };
}

export function parseSegmentPoints(body: unknown): SegmentPointsRequest {
  const o = asObject(body);
  const imageId = uuid(o, 'image_id');
  const rawPoints = o.points;
  if (
    !Array.isArray(rawPoints) ||
    rawPoints.length < 1 ||
    rawPoints.length > 2
  ) {
    throw unprocessableEntity('points must be an array of 1–2 items', {
      field: 'points',
    });
  }
  const points = rawPoints.map((p, idx) => {
    if (typeof p !== 'object' || p === null) {
      throw unprocessableEntity(`points[${idx}] must be an object`, {
        field: `points[${idx}]`,
      });
    }
    const pt = p as Record<string, unknown>;
    if (
      typeof pt.x !== 'number' ||
      !Number.isFinite(pt.x) ||
      typeof pt.y !== 'number' ||
      !Number.isFinite(pt.y)
    ) {
      throw unprocessableEntity(
        `points[${idx}] must have numeric x and y coordinates`,
        { field: `points[${idx}]` },
      );
    }
    if (pt.label !== 0 && pt.label !== 1) {
      throw unprocessableEntity(`points[${idx}].label must be 0 or 1`, {
        field: `points[${idx}].label`,
      });
    }
    return { x: pt.x, y: pt.y, label: pt.label as 0 | 1 };
  });
  return { image_id: imageId, points };
}

export function parseProductPatch(body: unknown): ProductPatch {
  const o = asObject(body);
  const patch: ProductPatch = {};
  if (has(o, 'name'))
    patch.name = o.name === null ? null : text(o, 'name', 120);
  if (has(o, 'price')) patch.price = money(o, 'price');
  if (has(o, 'cost_price')) {
    patch.cost_price = o.cost_price === null ? null : money(o, 'cost_price');
  }
  if (has(o, 'base_unit')) patch.base_unit = text(o, 'base_unit', 20, 1);
  if (has(o, 'barcode')) {
    patch.barcode = o.barcode === null ? null : text(o, 'barcode', 64);
  }
  if (has(o, 'category_id')) {
    patch.category_id = o.category_id === null ? null : uuid(o, 'category_id');
  }
  if (has(o, 'units')) {
    if (!Array.isArray(o.units)) fail('units', 'must be an array');
    patch.units = (o.units as unknown[]).map(unit);
  }
  if (has(o, 'archived')) {
    if (typeof o.archived !== 'boolean') fail('archived', 'must be a boolean');
    patch.archived = o.archived as boolean;
  }
  return patch;
}

function saleLine(value: unknown): SaleLineInput {
  const o = asObject(value, 'lines[]');
  const source = oneOf(o, 'source', [
    'camera',
    'multi_photo',
    'barcode',
    'grid',
    'manual',
  ] as const);
  const productId = o.product_id ?? null;
  if (productId !== null && !isUuid(productId))
    fail('product_id', 'must be a UUID or null');
  if (productId === null && source !== 'manual') {
    fail('product_id', 'may be null only for manual lines');
  }
  return {
    id: uuid(o, 'id'),
    product_id: productId as string | null,
    unit_id:
      o.unit_id === undefined || o.unit_id === null ? null : uuid(o, 'unit_id'),
    source,
    quantity: intIn(o, 'quantity', 1, 999),
    unit_price: money(o, 'unit_price'),
    ...(has(o, 'manual_label')
      ? { manual_label: text(o, 'manual_label', 80) }
      : {}),
    detection_id:
      o.detection_id === undefined || o.detection_id === null
        ? null
        : uuid(o, 'detection_id'),
    suggested_product_id:
      o.suggested_product_id === undefined || o.suggested_product_id === null
        ? null
        : uuid(o, 'suggested_product_id'),
  };
}

export function parseCreateSale(body: unknown): CreateSaleRequest {
  const o = asObject(body);
  if (!Array.isArray(o.lines) || o.lines.length < 1 || o.lines.length > 200) {
    fail('lines', 'must contain 1–200 lines');
  }
  if (
    has(o, 'scan_ids') &&
    !(Array.isArray(o.scan_ids) && o.scan_ids.every(isUuid))
  ) {
    fail('scan_ids', 'must be an array of UUIDs');
  }
  return {
    id: uuid(o, 'id'),
    sold_at: dateTime(o, 'sold_at'),
    payment_method: oneOf(o, 'payment_method', ['cash', 'transfer'] as const),
    total: money(o, 'total'),
    lines: (o.lines as unknown[]).map(saleLine),
    ...(has(o, 'cash_received')
      ? { cash_received: money(o, 'cash_received') }
      : {}),
    ...(has(o, 'vietqr_memo')
      ? { vietqr_memo: text(o, 'vietqr_memo', 25) }
      : {}),
    ...(has(o, 'scan_ids') ? { scan_ids: o.scan_ids as string[] } : {}),
  };
}

export function parseCreateExpense(body: unknown): CreateExpenseRequest {
  const o = asObject(body);
  if (has(o, 'purchase_lines') && !Array.isArray(o.purchase_lines)) {
    fail('purchase_lines', 'must be an array');
  }
  return {
    id: uuid(o, 'id'),
    spent_at: dateTime(o, 'spent_at'),
    amount: money(o, 'amount'),
    category: oneOf(o, 'category', [
      'nhap_hang',
      'dien',
      'nuoc',
      'khac',
    ] as const),
    paid_with: oneOf(o, 'paid_with', ['cash_box', 'other'] as const),
    ...(has(o, 'image_id') ? { image_id: uuid(o, 'image_id') } : {}),
    ...(has(o, 'note') ? { note: text(o, 'note', 500) } : {}),
    ...(has(o, 'purchase_lines')
      ? {
          purchase_lines: (o.purchase_lines as unknown[]).map((line) => {
            const l = asObject(line, 'purchase_lines[]');
            return {
              product_id: uuid(l, 'product_id'),
              unit_id:
                l.unit_id === undefined || l.unit_id === null
                  ? null
                  : uuid(l, 'unit_id'),
              quantity: intIn(l, 'quantity', 1, 1_000_000),
              unit_cost: money(l, 'unit_cost'),
            };
          }),
        }
      : {}),
  };
}

export function parseDayClose(body: unknown): {
  counted_cash: number;
  opening_float: number;
  note: string | null;
} {
  const o = asObject(body);
  return {
    counted_cash: money(o, 'counted_cash'),
    opening_float: has(o, 'opening_float') ? money(o, 'opening_float') : 0,
    note: has(o, 'note') ? text(o, 'note', 500) : null,
  };
}

export function parseAccept(body: unknown): { new_price?: number } {
  const o = asObject(body);
  return has(o, 'new_price') ? { new_price: money(o, 'new_price') } : {};
}

export function parseDate(value: string, field: string): string {
  return isDateString(value)
    ? value
    : fail(field, 'must be a date (YYYY-MM-DD)');
}

export function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 200
    ? n
    : fail('limit', 'must be an integer 1–200');
}

export function parseCursor(value: string | null): number {
  if (value === null || value === '') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0
    ? n
    : fail('cursor', 'is not a valid cursor');
}

export function paginate<T>(
  items: T[],
  query: URLSearchParams,
): { items: T[]; next_cursor: string | null } {
  const limit = parseLimit(query.get('limit'));
  const start = parseCursor(query.get('cursor'));
  const end = start + limit;
  return {
    items: items.slice(start, end),
    next_cursor: end < items.length ? String(end) : null,
  };
}

export function parseResolveManualLine(body: unknown): ResolveManualLineInput {
  const o = asObject(body);
  const action = oneOf(o, 'action', ['link', 'enrolled', 'dismiss'] as const);
  return has(o, 'product_id')
    ? { action, product_id: uuid(o, 'product_id') }
    : { action };
}
