import { isLowStock, LOW_STOCK_THRESHOLD } from './stock';
import type { ProductWithStock } from './types';

const product = (over: Partial<ProductWithStock>) =>
  ({ id: 'p', archived: false, ...over }) as ProductWithStock;

test('threshold is 5', () => expect(LOW_STOCK_THRESHOLD).toBe(5));

test('isLowStock: at or below threshold, ignores archived and unknown stock', () => {
  expect(isLowStock(product({ stock_quantity: 5 }))).toBe(true);
  expect(isLowStock(product({ stock_quantity: 0 }))).toBe(true);
  expect(isLowStock(product({ stock_quantity: 6 }))).toBe(false);
  expect(isLowStock(product({}))).toBe(false);
  expect(isLowStock(product({ stock_quantity: 1, archived: true }))).toBe(
    false,
  );
  expect(isLowStock(product({ stock_quantity: 8 }), 10)).toBe(true);
});
