import type { BarcodeScanningResult } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Product } from '@/lib/api';
import { validBarcode } from './barcode';

type Options = {
  enabled: boolean;
  lookup: (code: string) => Promise<Product | null>;
  onResult: (code: string, product: Product | null) => void;
  onError: () => void;
};

/** Serializes reads, debounces each code, and discards lookups after a result/sheet/focus change. */
export function useBarcodeScanner({
  enabled,
  lookup,
  onResult,
  onError,
}: Options) {
  const reads = useRef(new Map<string, number>());
  const pending = useRef(false);
  const generation = useRef(0);
  const active = useRef(enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    active.current = enabled;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, [enabled]);

  const scan = useCallback(
    async ({ data }: Pick<BarcodeScanningResult, 'data' | 'type'>) => {
      const code = data;
      if (!enabled || !active.current || pending.current || !validBarcode(code))
        return;
      const now = Date.now();
      const last = reads.current.get(code);
      if (last !== undefined && now - last < 2000) return;
      reads.current.set(code, now);
      pending.current = true;
      setBusy(true);
      const token = generation.current;
      try {
        const product = await lookup(code);
        if (token === generation.current) onResult(code, product);
      } catch {
        if (token === generation.current) onError();
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [enabled, lookup, onResult, onError],
  );
  return { scan, busy };
}
