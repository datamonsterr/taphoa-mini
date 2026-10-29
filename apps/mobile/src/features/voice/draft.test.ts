import type { VoiceSaleDraft } from '@taphoa/api-client';

import type { Customer } from '@/lib/api';

import {
  activeLines,
  blocker,
  cartLines,
  correctionsByUtterance,
  draftReducer,
  draftTotal,
  fromServerDraft,
  isEdited,
  itemCount,
  saleRequest,
  type Draft,
} from './draft';

const product = (id: string, name: string, price: number) => ({
  id,
  name,
  price,
  base_unit: 'lon',
});
const coca = product('p-coca', 'Coca', 10000);
const pepsi = product('p-pepsi', 'Pepsi', 9000);
const sevenUp = product('p-7up', '7Up', 8000);

const server: VoiceSaleDraft = {
  payment_method: 'cash',
  total: 29000,
  lines: [
    {
      id: 'l1',
      spoken: 'coca',
      status: 'matched',
      product: coca,
      unit_id: 'u1',
      quantity: 2,
      unit_price: 10000,
      price_source: 'catalog',
      price_mismatch: false,
      needs_price: false,
    },
    {
      id: 'l2',
      spoken: 'nước ngọt',
      status: 'ambiguous',
      product: pepsi,
      candidates: [pepsi, sevenUp],
      quantity: 1,
      unit_price: 9000,
      price_source: 'catalog',
      price_mismatch: false,
      needs_price: false,
    },
    {
      id: 'l3',
      spoken: 'gạo ST25',
      status: 'unknown',
      quantity: 1,
      unit_price: 35000,
      price_source: 'spoken',
      price_mismatch: false,
      needs_price: false,
    },
  ],
};
const start = (): Draft => fromServerDraft(server, 'utt-1');
const customer = { id: 'c1', name: 'Chị Lan' } as Customer;

test('maps the server draft and totals the lines', () => {
  const draft = start();
  expect(draft.lines.map((l) => l.status)).toEqual([
    'matched',
    'ambiguous',
    'unknown',
  ]);
  expect(draftTotal(draft)).toBe(2 * 10000 + 9000 + 35000);
  expect(itemCount(draft)).toBe(4);
  expect(isEdited(draft)).toBe(false);
});

test('stepper clamps at 1 and 999, remove hides the line', () => {
  let draft = start();
  draft = draftReducer(draft, { type: 'decrement', id: 'l1' });
  draft = draftReducer(draft, { type: 'decrement', id: 'l1' });
  expect(draft.lines[0]!.quantity).toBe(1);
  for (let i = 0; i < 1000; i++)
    draft = draftReducer(draft, { type: 'increment', id: 'l1' });
  expect(draft.lines[0]!.quantity).toBe(999);
  draft = draftReducer(draft, { type: 'remove', id: 'l3' });
  expect(activeLines(draft).map((l) => l.id)).toEqual(['l1', 'l2']);
});

test('picking a candidate changes product and catalog price and is a correction', () => {
  const draft = draftReducer(start(), {
    type: 'pick',
    id: 'l2',
    productId: 'p-7up',
  });
  expect(draft.lines[1]).toMatchObject({
    status: 'matched',
    unitPrice: 8000,
    unitId: null,
  });
  expect(correctionsByUtterance(draft).get('utt-1')).toEqual([
    { line_id: 'l2', chosen_product_id: 'p-7up', unit_price: 8000 },
  ]);
  expect(isEdited(draft)).toBe(true);
});

test('a spoken price survives a pick and flags a mismatch with the catalog', () => {
  const spoken = fromServerDraft(
    {
      ...server,
      lines: [
        {
          ...server.lines[1]!,
          unit_price: 12000,
          price_source: 'spoken',
          price_mismatch: true,
        },
      ],
    },
    'u',
  );
  const next = draftReducer(spoken, {
    type: 'pick',
    id: 'l2',
    productId: 'p-7up',
  });
  expect(next.lines[0]).toMatchObject({
    unitPrice: 12000,
    priceMismatch: true,
  });
});

test('retyping a price clears the mismatch pill', () => {
  const flagged = {
    ...start(),
    lines: start().lines.map((l) =>
      l.id === 'l1' ? { ...l, priceMismatch: true } : l,
    ),
  };
  const next = draftReducer(flagged, { type: 'price', id: 'l1', price: 12000 });
  expect(next.lines[0]).toMatchObject({
    unitPrice: 12000,
    priceMismatch: false,
  });
  expect(correctionsByUtterance(next).get('utt-1')).toEqual([
    { line_id: 'l1', unit_price: 12000 },
  ]);
});

test('resolving an unknown line to a catalog product makes it a matched line', () => {
  const draft = draftReducer(start(), {
    type: 'resolve',
    id: 'l3',
    product: { id: 'p-rice', name: 'Gạo ST25', price: 30000 },
  });
  expect(draft.lines[2]).toMatchObject({
    status: 'matched',
    unitPrice: 35000,
    priceMismatch: true,
  });
});

test('corrections list removed lines and group by utterance', () => {
  let draft = draftReducer(start(), { type: 'remove', id: 'l3' });
  draft = draftReducer(draft, {
    type: 'append',
    draft: fromServerDraft(
      { ...server, lines: [{ ...server.lines[0]!, id: 'm1' }] },
      'utt-2',
    ),
  });
  draft = draftReducer(draft, { type: 'increment', id: 'm1' });
  const groups = correctionsByUtterance(draft);
  expect(groups.get('utt-1')).toEqual([{ line_id: 'l3', removed: true }]);
  expect(groups.get('utt-2')).toEqual([{ line_id: 'm1', quantity: 3 }]);
});

test('payment or customer changes count as edits', () => {
  expect(
    isEdited(draftReducer(start(), { type: 'payment', method: 'credit' })),
  ).toBe(true);
  expect(isEdited(draftReducer(start(), { type: 'customer', customer }))).toBe(
    true,
  );
});

test('blockers: empty, missing price, credit without customer, transfer with unknown line', () => {
  const draft = start();
  expect(blocker(draft)).toBeNull();
  expect(
    blocker(draftReducer(draft, { type: 'payment', method: 'transfer' })),
  ).toBe('unknown');
  expect(
    blocker(draftReducer(draft, { type: 'payment', method: 'credit' })),
  ).toBe('customer');
  const noPrice = {
    ...draft,
    lines: draft.lines.map((l) => ({
      ...l,
      unitPrice: l.id === 'l1' ? null : l.unitPrice,
    })),
  };
  expect(blocker(noPrice)).toBe('price');
  const empty = [draft.lines[0]!, draft.lines[1]!, draft.lines[2]!].reduce(
    (d, l) => draftReducer(d, { type: 'remove', id: l.id }),
    draft,
  );
  expect(blocker(empty)).toBe('empty');
});

test('cash sale body: voice lines for products, manual lines with their label', () => {
  const body = saleRequest(start(), 'sale-1', '2026-10-28T03:00:00.000Z');
  expect(body).toMatchObject({
    id: 'sale-1',
    payment_method: 'cash',
    cash_received: 64000,
    total: 64000,
  });
  expect(body.lines).toEqual([
    {
      id: 'l1',
      source: 'voice',
      product_id: 'p-coca',
      unit_id: 'u1',
      quantity: 2,
      unit_price: 10000,
    },
    {
      id: 'l2',
      source: 'voice',
      product_id: 'p-pepsi',
      quantity: 1,
      unit_price: 9000,
    },
    {
      id: 'l3',
      source: 'manual',
      manual_label: 'gạo ST25',
      quantity: 1,
      unit_price: 35000,
    },
  ]);
});

test('credit sale body carries the customer and the whole total as debt', () => {
  let draft = draftReducer(start(), { type: 'payment', method: 'credit' });
  draft = draftReducer(draft, { type: 'customer', customer });
  const body = saleRequest(draft, 's', 'now');
  expect(body).toMatchObject({
    payment_method: 'credit',
    credit: { customer_id: 'c1', amount: 64000 },
    total: 64000,
  });
  expect(body).not.toHaveProperty('cash_received');
});

test('cart lines keep quantity and price and skip lines without a product', () => {
  expect(cartLines(start())).toEqual([
    {
      productId: 'p-coca',
      name: 'Coca',
      price: 10000,
      qty: 2,
      source: 'voice',
    },
    {
      productId: 'p-pepsi',
      name: 'Pepsi',
      price: 9000,
      qty: 1,
      source: 'voice',
    },
  ]);
});
