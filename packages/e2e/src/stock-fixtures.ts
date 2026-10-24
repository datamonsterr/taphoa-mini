import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApiClient } from '@taphoa/api-client';
import { expect } from 'vitest';

export const receiptPhoto = readFileSync(
  new URL(
    '../../../apps/backend/crates/recognition/tests/fixtures/receipts/receipt-1.jpg',
    import.meta.url,
  ),
);
export const productPhoto = readFileSync(
  new URL(
    '../../../apps/backend/tests/fixtures/shelf-1024.jpg',
    import.meta.url,
  ),
);
export const expectedReceipt: {
  lines: { product_name: string; quantity: number; cost: number }[];
  total: number;
} = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/backend/crates/recognition/tests/fixtures/receipts/receipt-1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

export function uuid7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function catalogProduct(client: ApiClient, name: string) {
  const image = await client.uploadImage(
    new File([productPhoto], 'product.jpg', { type: 'image/jpeg' }),
    'enrollment',
  );
  expect(image.response.status, JSON.stringify(image.error)).toBe(201);
  const product = await client.raw.POST('/v1/products', {
    body: {
      id: uuid7(),
      name,
      price: 15000,
      image_ids: [image.data!.id],
      force_new: true,
    },
  });
  expect(product.response.status, JSON.stringify(product.error)).toBe(201);
  return product.data!;
}

export function percentile(values: number[], fraction: number): number {
  return [...values].sort((a, b) => a - b)[
    Math.ceil(fraction * values.length) - 1
  ]!;
}
