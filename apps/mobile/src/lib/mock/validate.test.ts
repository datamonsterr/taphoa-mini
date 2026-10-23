import { newUuid } from '@/lib/uuid';

import {
  asObject,
  isMoney,
  paginate,
  parseAccept,
  parseCreateExpense,
  parseCreateProduct,
  parseCreateSale,
  parseCursor,
  parseDate,
  parseDayClose,
  parseInvite,
  parseLimit,
  parseProductPatch,
  parseResolveManualLine,
  parseStorePatch,
} from './validate';

const bad = { status: 400, code: 'validation_failed' };
const id = newUuid();
const line = {
  id,
  product_id: id,
  source: 'camera',
  quantity: 1,
  unit_price: 100,
};
const sale = {
  id,
  sold_at: '2026-10-23T08:00:00+07:00',
  payment_method: 'cash',
  total: 100,
  lines: [line],
};
const expense = {
  id,
  spent_at: '2026-10-23T08:00:00Z',
  amount: 5,
  category: 'khac',
  paid_with: 'other',
};

test('asObject and isMoney', () => {
  expect(asObject({ a: 1 })).toEqual({ a: 1 });
  for (const v of [null, [], 'x', 3])
    expect(() => asObject(v)).toThrow(expect.objectContaining(bad));
  expect([
    isMoney(0),
    isMoney(10),
    isMoney(-1),
    isMoney(1.5),
    isMoney('1'),
  ]).toEqual([true, true, false, false, false]);
});

test('parseStorePatch accepts partial valid patches and null bank account', () => {
  expect(parseStorePatch({})).toEqual({});
  const bank = {
    bank_bin: '970436',
    account_number: '0123456789',
    account_name: 'NGUYEN THI BA',
    bank_short_name: 'VCB',
  };
  expect(
    parseStorePatch({
      name: 'A',
      bank_account: bank,
      margin_threshold_pct: 0,
      sales_memo_prefix: 'TH',
    }),
  ).toEqual({
    name: 'A',
    bank_account: bank,
    margin_threshold_pct: 0,
    sales_memo_prefix: 'TH',
  });
  expect(parseStorePatch({ bank_account: null })).toEqual({
    bank_account: null,
  });
  expect(
    parseStorePatch({
      bank_account: {
        bank_bin: '970436',
        account_number: 'abcd',
        account_name: 'X',
      },
    }).bank_account,
  ).toEqual({
    bank_bin: '970436',
    account_number: 'abcd',
    account_name: 'X',
  });
});

test.each([
  [{ name: '' }],
  [{ name: 'x'.repeat(81) }],
  [{ margin_threshold_pct: 101 }],
  [{ margin_threshold_pct: 'x' }],
  [{ sales_memo_prefix: '123456789' }],
  [{ bank_account: 'x' }],
  [
    {
      bank_account: {
        bank_bin: '12',
        account_number: '12345',
        account_name: 'A',
      },
    },
  ],
  [
    {
      bank_account: {
        bank_bin: 'abcdef',
        account_number: '12345',
        account_name: 'A',
      },
    },
  ],
  [
    {
      bank_account: {
        bank_bin: '970436',
        account_number: '12-45',
        account_name: 'A',
      },
    },
  ],
])('parseStorePatch rejects %j', (body) => {
  expect(() => parseStorePatch(body)).toThrow(expect.objectContaining(bad));
});

test('parseInvite applies defaults, clamps ttl and never rejects', () => {
  expect(parseInvite({})).toEqual({
    role: 'seller',
    can_enroll: false,
    ttl_seconds: 600,
  });
  expect(parseInvite(undefined)).toEqual({
    role: 'seller',
    can_enroll: false,
    ttl_seconds: 600,
  });
  expect(parseInvite({ role: 'lead', ttl_seconds: 5 })).toEqual({
    role: 'lead',
    can_enroll: true,
    ttl_seconds: 60,
  });
  expect(
    parseInvite({ role: 'seller', can_enroll: true, ttl_seconds: 10 ** 6 }),
  ).toEqual({ role: 'seller', can_enroll: true, ttl_seconds: 86400 });
});

test('parseCreateProduct builds the request and rejects bad input', () => {
  const full = parseCreateProduct({
    id,
    price: 1000,
    image_ids: [id],
    name: 'A',
    base_unit: 'chai',
    cost_price: 500,
    barcode: '123',
    category_id: id,
    units: [
      { id, name: 'thùng', quantity_in_base: 6, price: 5000, barcode: '9' },
      { id, name: 'lốc', quantity_in_base: 3, price: 2500 },
    ],
  });
  expect(full).toMatchObject({
    force_new: false,
    units: [{ barcode: '9' }, { name: 'lốc' }],
  });
  expect(full.units![1]).not.toHaveProperty('barcode');
  expect(
    parseCreateProduct({ id, price: 1, image_ids: [id], force_new: true })
      .force_new,
  ).toBe(true);
  for (const body of [
    { price: 1, image_ids: [id] },
    { id, price: -1, image_ids: [id] },
    { id, price: 1, image_ids: [] },
    { id, price: 1, image_ids: ['x'] },
    { id, price: 1, image_ids: Array(6).fill(id) },
    { id, price: 1, image_ids: [id], units: 'x' },
    { id, price: 1, image_ids: [id], name: 'x'.repeat(121) },
    {
      id,
      price: 1,
      image_ids: [id],
      units: [{ id, name: 'a', quantity_in_base: 0, price: 1 }],
    },
  ]) {
    expect(() => parseCreateProduct(body)).toThrow(
      expect.objectContaining(bad),
    );
  }
});

test('parseProductPatch handles nullable fields and rejects bad types', () => {
  expect(
    parseProductPatch({
      name: null,
      price: 5,
      cost_price: null,
      base_unit: 'gói',
      barcode: null,
      category_id: null,
      archived: true,
      units: [],
    }),
  ).toEqual({
    name: null,
    price: 5,
    cost_price: null,
    base_unit: 'gói',
    barcode: null,
    category_id: null,
    archived: true,
    units: [],
  });
  expect(
    parseProductPatch({
      name: 'A',
      cost_price: 3,
      barcode: 'b',
      category_id: id,
    }),
  ).toEqual({ name: 'A', cost_price: 3, barcode: 'b', category_id: id });
  for (const body of [
    { price: 1.5 },
    { archived: 'yes' },
    { units: 'x' },
    { category_id: 'x' },
    { base_unit: '' },
  ]) {
    expect(() => parseProductPatch(body)).toThrow(expect.objectContaining(bad));
  }
});

test('parseCreateSale', () => {
  expect(
    parseCreateSale({
      ...sale,
      cash_received: 200,
      vietqr_memo: 'TH X',
      scan_ids: [id],
    }),
  ).toMatchObject({
    cash_received: 200,
    vietqr_memo: 'TH X',
    scan_ids: [id],
    lines: [{ unit_id: null, detection_id: null, suggested_product_id: null }],
  });
  const manual = parseCreateSale({
    ...sale,
    lines: [
      {
        ...line,
        product_id: undefined,
        source: 'manual',
        manual_label: 'Kẹo',
        unit_id: id,
        detection_id: id,
        suggested_product_id: id,
      },
    ],
  });
  expect(manual.lines[0]).toMatchObject({
    product_id: null,
    manual_label: 'Kẹo',
    unit_id: id,
  });
  for (const body of [
    { ...sale, lines: [] },
    { ...sale, lines: Array(201).fill(line) },
    { ...sale, sold_at: 'today' },
    { ...sale, sold_at: '2026-13-45T00:00:00Z' },
    { ...sale, payment_method: 'card' },
    { ...sale, scan_ids: ['x'] },
    { ...sale, lines: [{ ...line, source: 'telepathy' }] },
    { ...sale, lines: [{ ...line, product_id: null }] },
    { ...sale, lines: [{ ...line, product_id: 'x' }] },
    { ...sale, lines: [{ ...line, quantity: 1000 }] },
    { ...sale, lines: [{ ...line, manual_label: 'x'.repeat(81) }] },
  ]) {
    expect(() => parseCreateSale(body)).toThrow(expect.objectContaining(bad));
  }
});

test('parseCreateExpense', () => {
  expect(
    parseCreateExpense({
      ...expense,
      image_id: id,
      note: 'n',
      purchase_lines: [
        { product_id: id, quantity: 2, unit_cost: 5, unit_id: id },
        { product_id: id, quantity: 1, unit_cost: 1 },
      ],
    }),
  ).toMatchObject({
    image_id: id,
    note: 'n',
    purchase_lines: [{ unit_id: id }, { unit_id: null }],
  });
  for (const body of [
    { ...expense, category: 'x' },
    { ...expense, paid_with: 'x' },
    { ...expense, amount: -1 },
    { ...expense, purchase_lines: 'x' },
    {
      ...expense,
      purchase_lines: [{ product_id: id, quantity: 0, unit_cost: 1 }],
    },
    { ...expense, note: 'x'.repeat(501) },
  ]) {
    expect(() => parseCreateExpense(body)).toThrow(
      expect.objectContaining(bad),
    );
  }
});

test('parseDayClose, parseAccept, parseDate', () => {
  expect(parseDayClose({ counted_cash: 5 })).toEqual({
    counted_cash: 5,
    opening_float: 0,
    note: null,
  });
  expect(
    parseDayClose({ counted_cash: 5, opening_float: 2, note: 'n' }),
  ).toEqual({ counted_cash: 5, opening_float: 2, note: 'n' });
  expect(() => parseDayClose({})).toThrow(expect.objectContaining(bad));
  expect(parseAccept({})).toEqual({});
  expect(parseAccept({ new_price: 7 })).toEqual({ new_price: 7 });
  expect(() => parseAccept({ new_price: -1 })).toThrow(
    expect.objectContaining(bad),
  );
  expect(parseDate('2026-10-23', 'd')).toBe('2026-10-23');
  expect(() => parseDate('2026-02-30', 'd')).toThrow(
    expect.objectContaining(bad),
  );
});

test('limit, cursor and pagination', () => {
  expect(parseLimit(null)).toBe(50);
  expect(parseLimit('5')).toBe(5);
  for (const v of ['0', '201', 'x', '1.5'])
    expect(() => parseLimit(v)).toThrow(expect.objectContaining(bad));
  expect([parseCursor(null), parseCursor(''), parseCursor('7')]).toEqual([
    0, 0, 7,
  ]);
  for (const v of ['-1', 'x'])
    expect(() => parseCursor(v)).toThrow(expect.objectContaining(bad));
  const items = [1, 2, 3, 4, 5];
  expect(paginate(items, new URLSearchParams('limit=2'))).toEqual({
    items: [1, 2],
    next_cursor: '2',
  });
  expect(paginate(items, new URLSearchParams('limit=2&cursor=4'))).toEqual({
    items: [5],
    next_cursor: null,
  });
  expect(paginate(items, new URLSearchParams(''))).toEqual({
    items,
    next_cursor: null,
  });
});

test('parseResolveManualLine', () => {
  expect(parseResolveManualLine({ action: 'dismiss' })).toEqual({
    action: 'dismiss',
  });
  expect(parseResolveManualLine({ action: 'link', product_id: id })).toEqual({
    action: 'link',
    product_id: id,
  });
  for (const body of [
    {},
    { action: 'x' },
    { action: 'link', product_id: 'nope' },
  ]) {
    expect(() => parseResolveManualLine(body)).toThrow(
      expect.objectContaining(bad),
    );
  }
});
