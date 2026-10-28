import type { BarcodeSettings } from 'expo-camera';

export const BARCODE_SETTINGS: BarcodeSettings = {
  barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
};
export const validBarcode = (code: string) => /^\d{6,20}$/.test(code);
