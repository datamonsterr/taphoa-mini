import { productImageUri } from './assets';

test('returns a valid https uri per slug', () => {
  const uri = productImageUri('7up');
  expect(uri).toBe('https://mock.local/assets/products/7up.png');
  expect(() => new URL(uri)).not.toThrow();
});
