import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import {
  isApiError,
  isRateLimited,
  useCreateReceipt,
  useUploadImage,
  type Scan,
} from '@/lib/api';

import type { useScanSession } from './useScanSession';

type Args = {
  t: (key: string) => string;
  canEnroll: boolean;
  scan: Scan | null | undefined;
  phase: string;
  cameraReady: boolean;
  capture: ReturnType<typeof useScanSession>['capture'];
};

/** Reads a receipt from the frozen scan or a fresh shot; `notice` carries the failure for the strip. */
export function useReceiptReader({
  t,
  canEnroll,
  scan,
  phase,
  cameraReady,
  capture,
}: Args) {
  const router = useRouter();
  const [notice, setNotice] = useState('');
  const receiptCreate = useCreateReceipt();
  const receiptPending = useRef(false);
  const [readingReceipt, setReadingReceipt] = useState(false);
  const { mutateAsync: uploadImage } = useUploadImage();
  // Keep the same variables object for an explicit retry of the same uploaded image.
  const receiptInput = useRef<{ image_id: string } | null>(null);
  const readReceipt = async (
    open: (receiptId: string) => void = (id) =>
      router.push({ pathname: '/receipts', params: { receiptId: id } }),
  ) => {
    if (
      !canEnroll ||
      receiptPending.current ||
      (!scan && (!cameraReady || phase !== 'idle'))
    )
      return;
    receiptPending.current = true;
    setReadingReceipt(true);
    setNotice('');
    const started = performance.now();
    try {
      const create = async (imageId: string) => {
        if (receiptInput.current?.image_id !== imageId)
          receiptInput.current = { image_id: imageId };
        const receipt = await receiptCreate.mutateAsync(receiptInput.current);
        open(receipt.id);
      };
      if (scan) await create(scan.image.id);
      else
        await capture(async (shot) => {
          const image = await uploadImage({
            file: { uri: shot.uri, name: 'receipt.jpg', type: 'image/jpeg' },
            purpose: 'other',
          });
          await create(image.id);
        });
      console.info('receipt.tap_to_navigation', {
        duration_ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      setNotice(
        t(
          isApiError(error) && error.status === 403
            ? 'receiptPermission'
            : isRateLimited(error)
              ? 'receiptRateLimited'
              : isApiError(error) && error.code === 'no_text'
                ? 'receiptNoText'
                : 'receiptRetry',
        ),
      );
    } finally {
      receiptPending.current = false;
      setReadingReceipt(false);
    }
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  return { notice, setNotice, readingReceipt, readReceipt, uploadImage };
}
