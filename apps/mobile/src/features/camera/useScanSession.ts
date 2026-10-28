import type { CameraView } from 'expo-camera';
import { useCallback, useReducer, useRef, type RefObject } from 'react';

import type { CaptureMode } from '@/components/camera';
import { useCreateScan } from '@/lib/api';

import { takePhoto, toScanMode, toUploadFile } from './capture';
import { initialScanState, scanReducer, type Photo } from './scanReducer';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Drives one capture: take the photo, freeze it, upload it, keep the reducer in step. */
export function useScanSession(
  cameraRef: RefObject<CameraView | null>,
  mode: CaptureMode,
) {
  const [state, dispatch] = useReducer(scanReducer, initialScanState);
  const { mutateAsync } = useCreateScan();
  const tokenRef = useRef(0);
  const { phase, photo } = state;

  const submit = useCallback(
    async (token: number, shot: Photo) => {
      try {
        const scan = await mutateAsync({
          image: toUploadFile(shot),
          mode: toScanMode(mode),
        });
        dispatch({ type: 'scanned', token, scan });
      } catch (error) {
        dispatch({ type: 'failed', token, message: message(error) });
      }
    },
    [mutateAsync, mode],
  );

  const capture = useCallback(
    async (onPhoto?: (shot: Photo) => Promise<void>) => {
      if (phase !== 'idle') return;
      const token = ++tokenRef.current;
      dispatch({ type: 'shutter', token });
      let shot: Photo;
      try {
        shot = await takePhoto(cameraRef.current);
      } catch (error) {
        dispatch({ type: 'failed', token, message: message(error) });
        return;
      }
      dispatch({ type: 'captured', token, photo: shot });
      if (onPhoto) {
        try {
          await onPhoto(shot);
        } finally {
          dispatch({ type: 'reset' });
        }
      } else await submit(token, shot);
    },
    [phase, cameraRef, submit],
  );

  /** Scan the frozen photo again; with no photo (camera failure) go back to live. */
  const retry = useCallback(async () => {
    if (!photo) {
      dispatch({ type: 'reset' });
      return;
    }
    const token = ++tokenRef.current;
    dispatch({ type: 'retry', token });
    await submit(token, photo);
  }, [photo, submit]);

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
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
