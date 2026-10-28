import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product, ProductUnit } from './types';
import { getApiClient } from './client';
import { unwrap } from './errors';
import { keys } from './keys';

export const createProductUnit = (product: Product, unit: ProductUnit) =>
  unwrap(getApiClient().createProductUnit(product.id, product.units, unit));
export const updateProductUnit = (product: Product, unit: ProductUnit) =>
  unwrap(getApiClient().updateProductUnit(product.id, product.units, unit));
export const deleteProductUnit = (product: Product, unitId: string) =>
  unwrap(getApiClient().deleteProductUnit(product.id, product.units, unitId));

export function useSaveUnit(product: Product) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      change:
        | { kind: 'delete'; id: string }
        | { kind: 'create' | 'update'; unit: ProductUnit },
    ) =>
      change.kind === 'delete'
        ? deleteProductUnit(product, change.id)
        : change.kind === 'create'
          ? createProductUnit(product, change.unit)
          : updateProductUnit(product, change.unit),
    onSuccess: async (updated) => {
      qc.setQueryData(keys.products.detail(product.id), updated);
      await qc.invalidateQueries({ queryKey: keys.products.all() });
    },
  });
}
