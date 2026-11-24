import type { BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useLookupBarcode, type Product } from '@/lib/api';

import { useBarcodeScanner } from './useBarcodeScanner';

type Args = {
  focused: boolean;
  granted: boolean;
  cameraReady: boolean;
  idle: boolean;
  /** A sheet, a receipt read, a quick capture or a shot in review holds the scanner off. */
  blocked: boolean;
  canEnroll: boolean;
  setNotice: (notice: string) => void;
};

/** Barcode reads on the live preview: the looked-up product, and one stable handler for the camera. */
export function useBarcodeFlow({
  focused,
  granted,
  cameraReady,
  idle,
  blocked,
  canEnroll,
  setNotice,
}: Args) {
  const router = useRouter();
  const [barcodeResult, setBarcodeResult] = useState<{
    code: string;
    product: Product | null;
  } | null>(null);
  const lookupBarcode = useLookupBarcode();
  const barcodeEnabled =
    focused && granted && cameraReady && idle && !barcodeResult && !blocked;
  const barcodeScanner = useBarcodeScanner({
    enabled: barcodeEnabled,
    lookup: lookupBarcode,
    onResult: (code, product) => {
      setBarcodeResult({ code, product });
      if (!product) {
        if (canEnroll)
          router.push({ pathname: '/enroll', params: { barcode: code } });
        else
          setNotice('Mã vạch chưa có trong kho. Nhờ chủ cửa hàng thêm hàng.');
      }
    },
    onError: () => setNotice('Chưa tìm được mã vạch. Thử lại.'),
  });
  // The preview gets one stable handler: the latest scanner is read through a ref, so a new
  // scanner closure never re-renders the camera.
  const scanRef = useRef(barcodeScanner.scan);
  useEffect(() => {
    scanRef.current = barcodeScanner.scan;
  }, [barcodeScanner.scan]);
  const scanningRef = useRef(barcodeEnabled);
  useEffect(() => {
    scanningRef.current = barcodeEnabled;
  }, [barcodeEnabled]);
  const onScan = useCallback(
    (result: BarcodeScanningResult) => void scanRef.current(result),
    [],
  );
  useEffect(() => {
    if (!focused) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBarcodeResult(null);
    }
  }, [focused]);
  return {
    barcodeResult,
    setBarcodeResult,
    enabled: barcodeEnabled,
    busy: barcodeScanner.busy,
    scanningRef,
    onScan,
  };
}
