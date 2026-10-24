import { getApiClient } from './client';
import { unwrap } from './errors';
import type {
  Category,
  CreateProductRequest,
  Page,
  ProductWithStock,
  ProductImage,
  ProductPatch,
} from './types';

export type ListProductsParams = {
  q?: string;
  category_id?: string;
  include_archived?: boolean;
  limit?: number;
  cursor?: string | null;
};

export function listProducts(
  params: ListProductsParams = {},
): Promise<Page<ProductWithStock>> {
  const { cursor, ...rest } = params;
  return unwrap(
    getApiClient().raw.GET('/v1/products', {
      params: { query: { ...rest, ...(cursor ? { cursor } : {}) } },
    }),
  );
}

export const getProduct = (productId: string): Promise<ProductWithStock> =>
  unwrap(
    getApiClient().raw.GET('/v1/products/{productId}', {
      params: { path: { productId } },
    }),
  );

export const createProduct = (
  body: CreateProductRequest,
): Promise<ProductWithStock> =>
  unwrap(getApiClient().raw.POST('/v1/products', { body }));

export const patchProduct = (
  productId: string,
  body: ProductPatch,
): Promise<ProductWithStock> =>
  unwrap(
    getApiClient().raw.PATCH('/v1/products/{productId}', {
      params: { path: { productId } },
      body,
    }),
  );

export const addProductImage = (
  productId: string,
  body: { image_id: string; detection_id?: string },
): Promise<ProductImage> =>
  unwrap(
    getApiClient().raw.POST('/v1/products/{productId}/images', {
      params: { path: { productId } },
      body,
    }),
  );

export const listCategories = async (): Promise<Category[]> =>
  (await unwrap(getApiClient().raw.GET('/v1/categories'))).items;
