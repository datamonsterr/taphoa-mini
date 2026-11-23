import { getApiClient } from './client';
import { unwrap } from './errors';
import type {
  Category,
  CreateProductRequest,
  Page,
  Product,
  ProductImage,
  ProductPatch,
} from './types';

export type ListProductsParams = {
  q?: string;
  barcode?: string;
  category_id?: string;
  include_archived?: boolean;
  limit?: number;
  cursor?: string | null;
};

export function listProducts(
  params: ListProductsParams = {},
): Promise<Page<Product>> {
  const { cursor, ...rest } = params;
  return unwrap(
    getApiClient().raw.GET('/v1/products', {
      params: { query: { ...rest, ...(cursor ? { cursor } : {}) } },
    }),
  );
}

export const getProduct = (productId: string): Promise<Product> =>
  unwrap(
    getApiClient().raw.GET('/v1/products/{productId}', {
      params: { path: { productId } },
    }),
  );

export type PriceChange =
  import('@taphoa/api-client').components['schemas']['PriceChange'];

export const listPriceHistory = async (
  productId: string,
  params: { cursor?: string | null } = {},
): Promise<Page<PriceChange>> => {
  const page = await unwrap(
    getApiClient().raw.GET('/v1/products/{productId}/price-history', {
      params: {
        path: { productId },
        query: params.cursor ? { cursor: params.cursor } : {},
      },
    }),
  );
  return { items: page.items ?? [], next_cursor: page.next_cursor ?? null };
};

export const createProduct = (body: CreateProductRequest): Promise<Product> =>
  unwrap(getApiClient().raw.POST('/v1/products', { body }));

export const patchProduct = (
  productId: string,
  body: ProductPatch,
): Promise<Product> =>
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

/** UPC-A and its leading-zero EAN-13 representation refer to the same physical code. */
export function barcodeAliases(code: string) {
  if (code.length === 13 && code.startsWith('0')) return [code, code.slice(1)];
  if (code.length === 12) return [code, `0${code}`];
  return [code];
}
