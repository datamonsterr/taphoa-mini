import { newUuid } from '@/lib/uuid';
import type {
  CreateProductRequest,
  Image,
  ImagePurpose,
  Invite,
  ManualLine,
  MarginAlert,
  Member,
  Product,
  ProductImage,
  ResolveManualLineInput,
  ProductPatch,
  Role,
  Store,
  StorePatch,
} from '@/lib/api/types';

import { badRequest, conflict, notFound } from './errors';
import {
  buildSeed,
  makeAlert,
  marginPct,
  type MockState,
  type ProductRecord,
} from './fixtures';
import { randomCode } from './ids';
import { resetMockScenario } from './scenario';

let state: MockState = buildSeed();

/** Direct access to the in-memory DB (tests and the mock routes only). */
export function getMockDb(): MockState {
  return state;
}

/** Restores the seed data and the default scan scenario. */
export function resetMockDb(): void {
  state = buildSeed();
  resetMockScenario();
}

export const nowIso = () => new Date().toISOString();

const IMAGE_URL_TTL_MS = 60 * 60 * 1000;

/** Lower-case, accent-insensitive text for search (`hao hao` matches `Hảo Hảo`). */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

// ---- store, members -------------------------------------------------------

export function getCurrentMember(): Member {
  return state.members.find((m) => m.id === state.currentMemberId)!;
}

export function getStore(): Store {
  return state.store;
}

export function patchStore(patch: StorePatch): Store {
  state.store = { ...state.store, ...patch, version: state.store.version + 1 };
  return state.store;
}

export function createInvite(input: {
  role: Role;
  can_enroll: boolean;
  ttl_seconds: number;
}): Invite {
  const token = randomCode(16);
  return {
    token,
    join_url: `taphoa://join?token=${token}`,
    role: input.role,
    can_enroll: input.can_enroll,
    expires_at: new Date(Date.now() + input.ttl_seconds * 1000).toISOString(),
  };
}

// ---- images ---------------------------------------------------------------

export function registerImage(input: {
  contentType: Image['content_type'];
  byteSize: number;
  purpose?: ImagePurpose;
  uri?: string | null;
  width?: number;
  height?: number;
}): Image {
  const id = newUuid();
  const ext =
    input.contentType.split('/')[1] === 'jpeg'
      ? 'jpg'
      : input.contentType.split('/')[1];
  const image: Image = {
    id,
    object_key: `images/mock/${id}.${ext}`,
    content_type: input.contentType,
    byte_size: input.byteSize,
    purpose: input.purpose ?? 'other',
    width: input.width ?? 1080,
    height: input.height ?? 1440,
    url: input.uri || `https://mock.local/images/${id}.${ext}`,
    url_expires_at: new Date(Date.now() + IMAGE_URL_TTL_MS).toISOString(),
  };
  state.images.set(id, image);
  return image;
}

function toProductImage(image: Image, position: number): ProductImage {
  return {
    image_id: image.id,
    url: image.url,
    url_expires_at: image.url_expires_at,
    position,
  };
}

// ---- products -------------------------------------------------------------

export function findProductRecord(id: string): ProductRecord {
  const record = state.products.find((p) => p.product.id === id);
  if (!record) throw notFound('Product');
  return record;
}

export function getProduct(id: string): Product {
  return findProductRecord(id).product;
}

export function listProducts(filters: {
  q?: string | null;
  barcode?: string | null;
  categoryId?: string | null;
  includeArchived?: boolean;
}): Product[] {
  const needle = filters.q ? normalizeText(filters.q.trim()) : '';
  return state.products
    .map((p) => p.product)
    .filter((p) => filters.includeArchived || !p.archived)
    .filter((p) => !filters.barcode || p.barcode === filters.barcode)
    .filter((p) => !filters.categoryId || p.category_id === filters.categoryId)
    .filter((p) => !needle || normalizeText(p.name ?? '').includes(needle))
    .sort((a, b) =>
      normalizeText(a.name ?? '').localeCompare(normalizeText(b.name ?? '')),
    );
}

export function createProduct(req: CreateProductRequest): {
  product: Product;
  created: boolean;
} {
  const existing = state.products.find((p) => p.product.id === req.id);
  if (existing) return { product: existing.product, created: false };
  const images = req.image_ids.map((imageId, position) => {
    const image = state.images.get(imageId);
    if (!image) {
      throw badRequest(
        `image ${imageId} does not exist`,
        { image_id: imageId },
        'unknown_image',
      );
    }
    return toProductImage(image, position);
  });
  if (
    req.category_id &&
    !state.categories.some((c) => c.id === req.category_id)
  ) {
    throw badRequest(
      'category_id does not exist',
      { category_id: req.category_id },
      'unknown_category',
    );
  }
  if (
    req.from_manual_line_id &&
    !state.manualLines.some((l) => l.line_id === req.from_manual_line_id)
  ) {
    throw notFound('Manual line');
  }
  const product: Product = {
    id: req.id,
    name: req.name ?? null,
    price: req.price,
    base_unit: req.base_unit ?? 'cái',
    cost_price: req.cost_price ?? null,
    barcode: req.barcode ?? null,
    category_id: req.category_id ?? null,
    units: (req.units ?? []).map((u) => ({ ...u, barcode: u.barcode ?? null })),
    images,
    archived: false,
    version: 1,
    created_by: state.currentMemberId,
    updated_at: nowIso(),
  };
  state.products.push({ product });
  // Enrolling from a flagged manual line resolves that line, as the real server does.
  if (req.from_manual_line_id) {
    resolveManualLine(req.from_manual_line_id, {
      action: 'enrolled',
      product_id: product.id,
    });
  }
  return { product, created: true };
}

export function patchProduct(id: string, patch: ProductPatch): Product {
  const record = findProductRecord(id);
  if (
    patch.category_id &&
    !state.categories.some((c) => c.id === patch.category_id)
  ) {
    throw badRequest(
      'category_id does not exist',
      { category_id: patch.category_id },
      'unknown_category',
    );
  }
  record.product = {
    ...record.product,
    ...patch,
    version: record.product.version + 1,
    updated_at: nowIso(),
  };
  return record.product;
}

export function addProductImage(
  productId: string,
  imageId: string,
): ProductImage {
  const record = findProductRecord(productId);
  const image = state.images.get(imageId);
  if (!image) throw notFound('Image');
  const { images } = record.product;
  if (images.length >= 5)
    throw conflict('image_limit', 'A product holds at most 5 images');
  const added = toProductImage(image, images.length);
  record.product = {
    ...record.product,
    images: [...images, added],
    version: record.product.version + 1,
    updated_at: nowIso(),
  };
  return added;
}

// ---- alerts ---------------------------------------------------------------

export function listAlerts(status: MarginAlert['status']): MarginAlert[] {
  return state.alerts
    .filter((a) => a.status === status)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function findAlert(id: string): MarginAlert {
  const alert = state.alerts.find((a) => a.id === id);
  if (!alert) throw notFound('Alert');
  return alert;
}

function replaceAlert(next: MarginAlert): MarginAlert {
  state.alerts = state.alerts.map((a) => (a.id === next.id ? next : a));
  return next;
}

export function acceptAlert(id: string, newPrice?: number): MarginAlert {
  const alert = findAlert(id);
  if (alert.status !== 'open')
    throw conflict('alert_closed', 'Alert is already closed');
  const price = newPrice ?? alert.suggested_price;
  const product = patchProduct(alert.product_id, { price });
  return replaceAlert({
    ...alert,
    selling_price: price,
    margin_pct: marginPct(price, product.cost_price ?? 0),
    status: 'accepted',
  });
}

export function dismissAlert(id: string): MarginAlert {
  const alert = findAlert(id);
  return replaceAlert(
    alert.status === 'open' ? { ...alert, status: 'dismissed' } : alert,
  );
}

/** Opens (or refreshes) the margin alert of a product whose margin fell below the store threshold. */
export function raiseMarginAlert(
  product: Product,
  expenseId: string | null,
): MarginAlert | null {
  const cost = product.cost_price;
  if (
    cost === null ||
    cost === undefined ||
    marginPct(product.price, cost) >= state.store.margin_threshold_pct
  ) {
    return null;
  }
  const open = state.alerts.find(
    (a) => a.product_id === product.id && a.status === 'open',
  );
  const next = makeAlert(
    product,
    open?.id ?? newUuid(),
    open?.created_at ?? nowIso(),
    'open',
    expenseId,
  );
  if (open) return replaceAlert(next);
  state.alerts = [...state.alerts, next];
  return next;
}

// ---- manual lines (sold without catalog) -----------------------------------

export function listManualLines(status: ManualLine['status']): ManualLine[] {
  return state.manualLines
    .filter((l) => l.status === status)
    .sort(
      (a, b) =>
        b.sold_at.localeCompare(a.sold_at) ||
        b.line_id.localeCompare(a.line_id),
    );
}

export function resolveManualLine(
  lineId: string,
  input: ResolveManualLineInput,
): ManualLine {
  const line = state.manualLines.find((l) => l.line_id === lineId);
  if (!line) throw notFound('Manual line');
  if (line.status === 'resolved') return line;
  if (input.action !== 'dismiss') {
    if (!input.product_id) {
      throw badRequest('product_id is required for link and enrolled', {
        field: 'product_id',
      });
    }
    const record = findProductRecord(input.product_id);
    if (
      input.action === 'link' &&
      line.crop_image &&
      record.product.images.length < 5 &&
      !record.product.images.some((i) => i.image_id === line.crop_image!.id)
    ) {
      addProductImage(record.product.id, line.crop_image.id);
    }
  }
  const resolved: ManualLine = {
    ...line,
    status: 'resolved',
    resolution: {
      action: input.action,
      product_id: input.action === 'dismiss' ? null : input.product_id!,
      resolved_by: state.currentMemberId,
      resolved_at: nowIso(),
    },
  };
  state.manualLines = state.manualLines.map((l) =>
    l.line_id === lineId ? resolved : l,
  );
  return resolved;
}
