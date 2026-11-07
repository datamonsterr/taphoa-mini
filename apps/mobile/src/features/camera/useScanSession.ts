import { onlineManager } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type RefObject,
} from 'react';

import { RATE_LIMIT_MESSAGE, isRateLimited, useCreateScan } from '@/lib/api';

import { takePhoto, toUploadFile, type PictureTaker } from './capture';
import { voteScan, type VoteHistory } from './vision/identify';
import { capture as trackEvent } from '@/lib/analytics';
import { initialScanState, scanReducer, type Photo } from './scanReducer';

/** A scan with no answer after this long gives up, so the seller is never stuck on the spinner. */
export const SCAN_TIMEOUT_MS = 20_000;
export const SCAN_SLOW_MESSAGE = 'Mạng chậm, chưa nhận diện được. Thử lại.';
export const SCAN_OFFLINE_MESSAGE =
  'Không có mạng. Kiểm tra kết nối rồi thử lại.';
export const SCAN_FAILED_MESSAGE = 'Chưa nhận diện được';

const offline = () =>
  !onlineManager.isOnline() ||
  (typeof navigator !== 'undefined' && navigator.onLine === false);

/** What the seller reads on the error pill: what failed; the retry button says what to do. */
const message = (error: unknown) =>
  isRateLimited(error)
    ? RATE_LIMIT_MESSAGE
    : error instanceof TypeError || offline()
      ? SCAN_OFFLINE_MESSAGE
      : SCAN_FAILED_MESSAGE;

/** Drives one capture: take the photo, freeze it, upload it, keep the reducer in step. */
export function useScanSession(cameraRef: RefObject<PictureTaker | null>) {
  const [state, dispatch] = useReducer(scanReducer, initialScanState);
  const { mutateAsync } = useCreateScan();
  const tokenRef = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      tokenRef.current += 1;
      pending.current = false;
    },
    [],
  );
  const votes = useRef<VoteHistory>({});
  const timing = useRef({
    started: 0,
    trigger: 'tap' as 'tap' | 'auto' | 'retry',
  });
  const { phase, photo } = state;

  const submit = useCallback(
    async (token: number, shot: Photo) => {
      // React Query parks a mutation while offline, so say so now instead of after the timeout.
      if (offline()) {
        dispatch({ type: 'failed', token, message: SCAN_OFFLINE_MESSAGE });
        return;
      }
      // A late answer after the timeout is dropped: the reducer only takes `scanning` + same token.
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        dispatch({ type: 'failed', token, message: SCAN_SLOW_MESSAGE });
      }, SCAN_TIMEOUT_MS);
      try {
        const scan = await mutateAsync({
          image: toUploadFile(shot),
          mode: 'multi',
          boxes: shot.boxes,
        });
        if (token !== tokenRef.current || expired) return;
        const voted = voteScan(votes.current, scan);
        votes.current = voted.history;
        trackEvent('scan_result_received', {
          latency_ms: Math.round(performance.now() - timing.current.started),
          trigger: timing.current.trigger,
        });
        dispatch({
          type: 'scanned',
          token,
          scan: voted.scan,
          open: scan.detections.length === 1,
        });
      } catch (error) {
        dispatch({ type: 'failed', token, message: message(error) });
      } finally {
        clearTimeout(timer);
      }
    },
    [mutateAsync],
  );

  const capture = useCallback(
    async (
      onPhoto?: (shot: Photo) => Promise<void>,
      trigger: 'tap' | 'auto' = 'tap',
    ) => {
      if (phase !== 'idle' || pending.current) return;
      pending.current = true;
      timing.current = { started: performance.now(), trigger };
      const token = ++tokenRef.current;
      dispatch({ type: 'shutter', token });
      let shot: Photo;
      try {
        shot = await takePhoto(cameraRef.current);
      } catch (error) {
        pending.current = false;
        dispatch({ type: 'failed', token, message: message(error) });
        return;
      }
      if (token !== tokenRef.current) return;
      dispatch({ type: 'captured', token, photo: shot });
      if (onPhoto) {
        try {
          await onPhoto(shot);
        } finally {
          pending.current = false;
          dispatch({ type: 'reset' });
        }
      } else {
        await submit(token, shot);
        if (token === tokenRef.current) pending.current = false;
      }
    },
    [phase, cameraRef, submit],
  );

  /** Scan the frozen photo again; with no photo (camera failure) go back to live. */
  const retry = useCallback(async () => {
    if (!photo) {
      dispatch({ type: 'reset' });
      return;
    }
    timing.current = { started: performance.now(), trigger: 'retry' };
    const token = ++tokenRef.current;
    dispatch({ type: 'retry', token });
    await submit(token, photo);
  }, [photo, submit]);

  const reset = useCallback(() => {
    tokenRef.current += 1;
    pending.current = false;
    dispatch({ type: 'reset' });
  }, []);
  /** The matched boxes went to the cart: keep any unknown ones on screen, else go back to live. */
  const added = useCallback(() => dispatch({ type: 'added' }), []);
  const toggle = useCallback(
    (id: string) => dispatch({ type: 'toggle', id }),
    [],
  );
  const toggleOpen = useCallback(
    (id: string) => dispatch({ type: 'toggleOpen', id }),
    [],
  );
  const choose = useCallback(
    (id: string, productId: string) =>
      dispatch({ type: 'choose', id, productId }),
    [],
  );

  return { state, capture, retry, reset, added, toggle, toggleOpen, choose };
}
