import { selectCount, selectLines, selectTotal, useCartStore } from './cart';

const tea = { productId: 'tea', name: 'Trà', price: 12000, imageUrl: 'x.jpg' };
const noodle = { productId: 'noodle', name: 'Mì', price: 4500 };
const state = () => useCartStore.getState();

beforeEach(() => useCartStore.setState({ lines: [] }));

test('add creates a line with qty 1 and manual false', () => {
  state().add(tea);
  expect(selectLines(state())).toEqual([{ ...tea, qty: 1, manual: false }]);
});

test('add keeps the manual flag and bumps qty of an existing line', () => {
  state().add({ ...noodle, manual: true });
  state().add(tea);
  state().add(noodle);
  expect(state().lines[0]).toMatchObject({
    productId: 'noodle',
    qty: 2,
    manual: true,
  });
  expect(state().lines[1]).toMatchObject({ productId: 'tea', qty: 1 });
});

test('increment and decrement; decrement stops at 1', () => {
  state().add(tea);
  state().add(noodle);
  state().increment('tea');
  expect(state().lines[0]?.qty).toBe(2);
  expect(state().lines[1]?.qty).toBe(1);
  state().decrement('tea');
  state().decrement('tea');
  state().decrement('noodle');
  expect(state().lines.map((l) => l.qty)).toEqual([1, 1]);
});

test('remove and clear', () => {
  state().add(tea);
  state().add(noodle);
  state().remove('tea');
  expect(state().lines.map((l) => l.productId)).toEqual(['noodle']);
  state().clear();
  expect(state().lines).toEqual([]);
});

test('count and total selectors', () => {
  expect(selectCount(state())).toBe(0);
  expect(selectTotal(state())).toBe(0);
  state().add(tea);
  state().add(tea);
  state().add(noodle);
  expect(selectCount(state())).toBe(3);
  expect(selectTotal(state())).toBe(28500);
});

test('add carries the training labels and keeps the first line label on merge', () => {
  const labelled = {
    ...tea,
    detectionId: 'det-1',
    suggestedProductId: 'other',
    scanId: 'scan-1',
  };
  state().add(labelled);
  expect(state().lines[0]).toMatchObject(labelled);
  state().add({ ...tea, detectionId: 'det-2', scanId: 'scan-2' });
  expect(state().lines).toHaveLength(1);
  expect(state().lines[0]).toMatchObject({ qty: 2, detectionId: 'det-1' });
});

test('merging fills labels a line was missing', () => {
  state().add(tea);
  state().add({ ...tea, detectionId: 'det-9', scanId: 'scan-9' });
  expect(state().lines[0]).toMatchObject({
    qty: 2,
    detectionId: 'det-9',
    scanId: 'scan-9',
  });
});
