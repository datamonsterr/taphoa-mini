import { newUuid } from '@/lib/uuid';

import {
  acceptAlert,
  addProductImage,
  createInvite,
  createProduct,
  dismissAlert,
  getCurrentMember,
  getMockDb,
  getProduct,
  getStore,
  listAlerts,
  listManualLines,
  listProducts,
  normalizeText,
  patchProduct,
  patchStore,
  raiseMarginAlert,
  registerImage,
  resetMockDb,
  resolveManualLine,
} from './db';
import { MockHttpError } from './errors';
import { LEAD_ID, PRODUCT_IDS } from './fixtures';
import { setMockScenario } from './scenario';

beforeEach(resetMockDb);

const image = () => registerImage({ contentType: 'image/png', byteSize: 10 });

test('seed: demo store, bank account, lead + 2 members, 13 products with images', () => {
  const db = getMockDb();
  expect(db.store).toMatchObject({
    name: 'Tạp hóa Cô Ba',
    bank_account: { bank_bin: '970436' },
  });
  expect(db.members.map((m) => m.role)).toEqual(['lead', 'seller', 'seller']);
  expect(getCurrentMember().id).toBe(LEAD_ID);
  expect(db.products).toHaveLength(13);
  for (const { product } of db.products) {
    expect(product.images.length).toBeGreaterThanOrEqual(1);
    expect(product.images.length).toBeLessThanOrEqual(2);
    for (const img of product.images)
      expect(() => new URL(img.url)).not.toThrow();
  }
  expect(db.alerts.map((a) => a.status)).toEqual(['open', 'open']);
});

test('seed: 7 days of sales and expenses', () => {
  const db = getMockDb();
  expect(new Set(db.sales.map((s) => s.business_date)).size).toBe(7);
  expect(new Set(db.expenses.map((e) => e.business_date)).size).toBe(7);
  for (const sale of db.sales) {
    expect(sale.lines.reduce((t, l) => t + l.line_total, 0)).toBe(sale.total);
  }
});

test('resetMockDb restores the seed and the scenario', () => {
  createProduct({
    id: newUuid(),
    price: 1,
    image_ids: [image().id],
    force_new: false,
  });
  setMockScenario('multi');
  expect(getMockDb().products).toHaveLength(14);
  resetMockDb();
  expect(getMockDb().products).toHaveLength(13);
});

test('normalizeText strips accents, đ and case', () => {
  expect(normalizeText('Mì Hảo Hảo ĐỎ')).toBe('mi hao hao do');
});

test('listProducts: accent-insensitive search, category, barcode, archived, sorted', () => {
  expect(listProducts({ q: 'hao hao' }).map((p) => p.name)).toEqual([
    'Mì Hảo Hảo tôm chua cay',
  ]);
  expect(listProducts({ q: '  COCA ' })).toHaveLength(1);
  expect(listProducts({ q: 'zzz' })).toEqual([]);
  const drinks = getProduct(PRODUCT_IDS.coca).category_id;
  expect(listProducts({ categoryId: drinks }).length).toBe(5);
  const names = listProducts({}).map((p) => normalizeText(p.name ?? ''));
  expect(names).toEqual([...names].sort());
  patchProduct(PRODUCT_IDS.coca, { archived: true, barcode: '8934588' });
  expect(listProducts({}).some((p) => p.id === PRODUCT_IDS.coca)).toBe(false);
  expect(
    listProducts({ includeArchived: true, barcode: '8934588' }),
  ).toHaveLength(1);
});

test('createProduct stores the product, is idempotent on id, validates images and category', () => {
  const img = image();
  const id = newUuid();
  const first = createProduct({
    id,
    price: 12000,
    image_ids: [img.id],
    name: 'Sting đỏ',
    units: [
      { id: newUuid(), name: 'thùng', quantity_in_base: 24, price: 250000 },
    ],
    force_new: false,
  });
  expect(first.created).toBe(true);
  expect(first.product).toMatchObject({
    name: 'Sting đỏ',
    base_unit: 'cái',
    cost_price: null,
    version: 1,
    created_by: LEAD_ID,
  });
  expect(first.product.units[0]!.barcode).toBeNull();
  const again = createProduct({
    id,
    price: 1,
    image_ids: [img.id],
    force_new: false,
  });
  expect(again).toEqual({ product: first.product, created: false });
  expect(() =>
    createProduct({
      id: newUuid(),
      price: 1,
      image_ids: [newUuid()],
      force_new: false,
    }),
  ).toThrow(expect.objectContaining({ status: 400, code: 'unknown_image' }));
  expect(() =>
    createProduct({
      id: newUuid(),
      price: 1,
      image_ids: [img.id],
      category_id: newUuid(),
      force_new: false,
    }),
  ).toThrow(expect.objectContaining({ code: 'unknown_category' }));
});

test('patchProduct merges, bumps version, rejects unknown product and category', () => {
  const before = getProduct(PRODUCT_IDS.coca);
  const after = patchProduct(PRODUCT_IDS.coca, {
    price: 11000,
    name: null,
    cost_price: null,
  });
  expect(after).toMatchObject({
    price: 11000,
    name: null,
    cost_price: null,
    version: before.version + 1,
  });
  expect(() => patchProduct(newUuid(), { price: 1 })).toThrow(
    expect.objectContaining({ status: 404 }),
  );
  expect(() =>
    patchProduct(PRODUCT_IDS.coca, { category_id: newUuid() }),
  ).toThrow(MockHttpError);
});

test('addProductImage appends at the next position and stops at 5', () => {
  const added = addProductImage(PRODUCT_IDS.pepsi, image().id);
  expect(added.position).toBe(1);
  expect(() => addProductImage(PRODUCT_IDS.pepsi, newUuid())).toThrow(
    expect.objectContaining({ status: 404 }),
  );
  for (let i = 0; i < 3; i += 1) addProductImage(PRODUCT_IDS.pepsi, image().id);
  expect(() => addProductImage(PRODUCT_IDS.pepsi, image().id)).toThrow(
    expect.objectContaining({ status: 409, code: 'image_limit' }),
  );
});

test('store patch bumps the version; invite is a taphoa:// link with ttl', () => {
  const store = patchStore({ name: 'Mới', margin_threshold_pct: 20 });
  expect(store).toMatchObject({
    name: 'Mới',
    margin_threshold_pct: 20,
    version: 2,
  });
  expect(getStore()).toBe(store);
  const invite = createInvite({
    role: 'seller',
    can_enroll: false,
    ttl_seconds: 120,
  });
  expect(invite.join_url).toBe(`taphoa://join?token=${invite.token}`);
  expect(Date.parse(invite.expires_at) - Date.now()).toBeLessThanOrEqual(
    120_000,
  );
});

test('registerImage keeps uri, derives extension and falls back to a https url', () => {
  const a = registerImage({
    contentType: 'image/jpeg',
    byteSize: 5,
    uri: 'file:///x.jpg',
    purpose: 'checkout',
  });
  expect(a).toMatchObject({
    url: 'file:///x.jpg',
    purpose: 'checkout',
    width: 1080,
    height: 1440,
  });
  expect(a.object_key.endsWith('.jpg')).toBe(true);
  const b = registerImage({ contentType: 'image/webp', byteSize: 5 });
  expect(b.url).toMatch(/^https:\/\/mock\.local\/images\/.+\.webp$/);
  expect(b.purpose).toBe('other');
});

test('alerts: list by status, accept applies the suggested or given price, dismiss closes', () => {
  const [pepsi] = listAlerts('open').filter(
    (a) => a.product_name === 'Pepsi lon 330ml',
  );
  expect(pepsi).toMatchObject({
    cost_price: 9500,
    selling_price: 9000,
    margin_pct: -5.6,
  });
  const accepted = acceptAlert(pepsi!.id);
  expect(accepted.status).toBe('accepted');
  expect(accepted.selling_price).toBe(pepsi!.suggested_price);
  expect(getProduct(PRODUCT_IDS.pepsi).price).toBe(pepsi!.suggested_price);
  expect(() => acceptAlert(pepsi!.id)).toThrow(
    expect.objectContaining({ status: 409, code: 'alert_closed' }),
  );

  const [other] = listAlerts('open');
  expect(acceptAlert(other!.id, 40000).selling_price).toBe(40000);
  expect(listAlerts('accepted')).toHaveLength(2);
  expect(() => acceptAlert(newUuid())).toThrow(
    expect.objectContaining({ status: 404 }),
  );
  expect(() => dismissAlert(newUuid())).toThrow(
    expect.objectContaining({ status: 404 }),
  );
});

test('dismissAlert closes an open alert and leaves a closed one as is', () => {
  const [alert] = listAlerts('open');
  expect(dismissAlert(alert!.id).status).toBe('dismissed');
  expect(dismissAlert(alert!.id).status).toBe('dismissed');
  expect(listAlerts('dismissed')).toHaveLength(1);
});

test('raiseMarginAlert opens one alert per product and refreshes it', () => {
  const coca = getProduct(PRODUCT_IDS.coca);
  expect(raiseMarginAlert(coca, null)).toBeNull(); // healthy margin
  expect(raiseMarginAlert({ ...coca, cost_price: null }, null)).toBeNull();
  expect(raiseMarginAlert({ ...coca, cost_price: undefined }, null)).toBeNull();
  const low = patchProduct(PRODUCT_IDS.coca, { cost_price: 9800 });
  const alert = raiseMarginAlert(low, 'e1')!;
  expect(alert).toMatchObject({ status: 'open', expense_id: 'e1' });
  const refreshed = raiseMarginAlert({ ...low, cost_price: 9900 }, 'e2')!;
  expect(refreshed.id).toBe(alert.id);
  expect(refreshed.cost_price).toBe(9900);
  expect(
    listAlerts('open').filter((a) => a.product_id === low.id),
  ).toHaveLength(1);
});

describe('manual lines', () => {
  test('seed has 3 open manual lines tied to real sales', () => {
    const open = listManualLines('open');
    expect(open).toHaveLength(3);
    for (const line of open) {
      const sale = getMockDb().sales.find((s) => s.id === line.sale_id)!;
      expect(sale.lines.find((l) => l.id === line.line_id)).toMatchObject({
        source: 'manual',
        product_id: null,
        quantity: line.quantity,
      });
      expect(sale.lines.reduce((t, l) => t + l.line_total, 0)).toBe(sale.total);
    }
    expect(listManualLines('resolved')).toEqual([]);
  });

  test('createProduct with from_manual_line_id resolves that line as enrolled', () => {
    const [line] = listManualLines('open');
    const img = image();
    const id = newUuid();
    createProduct({
      id,
      price: 5000,
      image_ids: [img.id],
      from_manual_line_id: line!.line_id,
      force_new: false,
    });
    expect(listManualLines('open')).toHaveLength(2);
    expect(listManualLines('resolved')[0]).toMatchObject({
      line_id: line!.line_id,
      resolution: { action: 'enrolled', product_id: id },
    });
  });

  test('createProduct with an unknown manual line is a 404', () => {
    expect(() =>
      createProduct({
        id: newUuid(),
        price: 5000,
        image_ids: [image().id],
        from_manual_line_id: newUuid(),
        force_new: false,
      }),
    ).toThrow();
  });

  test('resolve: link, enrolled, dismiss; resolved lines are returned unchanged', () => {
    const [a, b, c] = listManualLines('open');
    expect(
      resolveManualLine(a!.line_id, {
        action: 'link',
        product_id: PRODUCT_IDS.coca,
      }),
    ).toMatchObject({
      status: 'resolved',
      resolution: {
        action: 'link',
        product_id: PRODUCT_IDS.coca,
        resolved_by: LEAD_ID,
      },
    });
    expect(
      resolveManualLine(b!.line_id, {
        action: 'enrolled',
        product_id: PRODUCT_IDS.pepsi,
      }).resolution?.action,
    ).toBe('enrolled');
    expect(
      resolveManualLine(c!.line_id, { action: 'dismiss' }).resolution
        ?.product_id,
    ).toBeNull();
    const again = resolveManualLine(a!.line_id, { action: 'dismiss' });
    expect(again.resolution?.action).toBe('link');
    expect(listManualLines('open')).toEqual([]);
    expect(listManualLines('resolved')).toHaveLength(3);
  });

  test('resolve rejects unknown line / product and a missing product_id', () => {
    const [line] = listManualLines('open');
    expect(() => resolveManualLine(newUuid(), { action: 'dismiss' })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => resolveManualLine(line!.line_id, { action: 'link' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() =>
      resolveManualLine(line!.line_id, {
        action: 'enrolled',
        product_id: newUuid(),
      }),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  test('link adds the line crop as a reference image (up to the limit)', () => {
    const crop = registerImage({ contentType: 'image/jpeg', byteSize: 1 });
    const [line] = listManualLines('open');
    getMockDb().manualLines = getMockDb().manualLines.map((l) =>
      l.line_id === line!.line_id ? { ...l, crop_image: crop } : l,
    );
    resolveManualLine(line!.line_id, {
      action: 'link',
      product_id: PRODUCT_IDS.pepsi,
    });
    expect(
      getProduct(PRODUCT_IDS.pepsi).images.map((i) => i.image_id),
    ).toContain(crop.id);

    const [next, last] = listManualLines('open');
    getMockDb().manualLines = getMockDb().manualLines.map((l) =>
      l.line_id === next!.line_id ? { ...l, crop_image: crop } : l,
    );
    resolveManualLine(next!.line_id, {
      action: 'link',
      product_id: PRODUCT_IDS.pepsi,
    }); // same crop: not added twice
    expect(
      getProduct(PRODUCT_IDS.pepsi).images.filter(
        (i) => i.image_id === crop.id,
      ),
    ).toHaveLength(1);
    for (let i = 0; i < 3; i += 1)
      addProductImage(PRODUCT_IDS.pepsi, image().id);
    const other = registerImage({ contentType: 'image/jpeg', byteSize: 1 });
    getMockDb().manualLines = getMockDb().manualLines.map((l) =>
      l.line_id === last!.line_id ? { ...l, crop_image: other } : l,
    );
    resolveManualLine(last!.line_id, {
      action: 'link',
      product_id: PRODUCT_IDS.pepsi,
    });
    expect(getProduct(PRODUCT_IDS.pepsi).images).toHaveLength(5);
  });
});
