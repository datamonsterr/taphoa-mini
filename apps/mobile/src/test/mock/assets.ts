export type ProductImageSlug =
  | 'coca'
  | 'coca-b'
  | 'pepsi'
  | '7up'
  | 'haohao'
  | 'haohao-b'
  | 'omachi'
  | 'vinamilk'
  | 'vinamilk-b'
  | 'lavie'
  | 'oreo'
  | 'trung'
  | 'tuongan'
  | 'namngu'
  | 'omo';

/** Fake image URL of a seeded product: the test double serves no bytes, only a valid URI. */
export function productImageUri(slug: ProductImageSlug): string {
  return `https://mock.local/assets/products/${slug}.png`;
}
