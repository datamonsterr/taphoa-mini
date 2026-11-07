import { CODE_SETTINGS, validBarcode } from './barcode';

test('QR is enabled and accepts digit codes only', () => {
  expect(CODE_SETTINGS.barcodeTypes).toContain('qr');
  expect(validBarcode('123456')).toBe(true);
  expect(validBarcode('https://example.com')).toBe(false);
});
