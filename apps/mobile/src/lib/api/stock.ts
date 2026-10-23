import type { ProductWithStock } from './types';

/** A product is low on stock at or below this many base units. */
export const LOW_STOCK_THRESHOLD = 5;

export const isLowStock = (
  product: ProductWithStock,
  threshold = LOW_STOCK_THRESHOLD,
): boolean =>
  !product.archived &&
  product.stock_quantity !== undefined &&
  product.stock_quantity <= threshold;
