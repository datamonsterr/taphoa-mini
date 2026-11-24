import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import type { Product, Scan } from '@/lib/api';
import { useCartStore } from '@/stores/cart';

import { toCartLines } from './detections';
import { isLowMatch } from './matching';

type Args = {
  scan: Scan | null | undefined;
  selected: Record<string, boolean>;
  chosen: Record<string, string>;
  fallbackName: string;
  barcodeResult: { code: string; product: Product | null } | null;
  clearBarcode: () => void;
  added: () => void;
};

/** The add button: puts the barcode product or the selected boxes in the cart. */
export function useAddToCart({
  scan,
  selected,
  chosen,
  fallbackName,
  barcodeResult,
  clearBarcode,
  added,
}: Args) {
  const router = useRouter();
  const addLine = useCartStore((s) => s.add);
  /** Bumps on every add, which plays the fly-to-cart feedback. */
  const [addCount, setAddCount] = useState(0);
  const onAdd = useCallback(() => {
    const isCartEmpty = useCartStore.getState().lines.length === 0;
    if (barcodeResult?.product) {
      const product = barcodeResult.product;
      addLine({
        productId: product.id,
        name: product.name ?? fallbackName,
        price: product.price,
        imageUrl: product.images[0]?.url,
        source: 'barcode',
      });
      clearBarcode();
    } else {
      if (!scan) return;
      const linesToAdd = toCartLines(scan, selected, chosen, fallbackName);
      for (const line of linesToAdd) addLine(line);
      added();
      const isSingleConfirmedScan =
        isCartEmpty &&
        linesToAdd.length === 1 &&
        scan.detections.length === 1 &&
        scan.detections[0].match === 'matched' &&
        !isLowMatch(scan.detections[0]) &&
        Object.keys(chosen).length === 0;
      if (isSingleConfirmedScan) {
        router.push({ pathname: '/pay', params: { method: 'cash' } });
      }
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAddCount((n) => n + 1);
  }, [
    barcodeResult,
    scan,
    selected,
    chosen,
    fallbackName,
    addLine,
    added,
    router,
    clearBarcode,
  ]);

  return { onAdd, addCount };
}
