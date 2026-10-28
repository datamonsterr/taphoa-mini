import { useEffect, useRef, useState, type RefObject } from 'react';
import { AppState } from 'react-native';

import { isApiError, useProbeDocument, type ScanDocument } from '@/lib/api';

import {
  discardProbePhoto,
  takeProbePhoto,
  toUploadFile,
  type PictureTaker,
} from './capture';
import type { Photo } from './scanReducer';

export const PROBE_INTERVAL_MS = 2500;

type Probe = {
  document: ScanDocument;
  imageSize: { width: number; height: number };
};

/** One capture/request at a time, only in the foreground live view; no persisted scan. */
export function useDocumentProbe(
  cameraRef: RefObject<PictureTaker | null>,
  enabled: boolean,
) {
  const { mutateAsync } = useProbeDocument();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const inFlight = useRef(false);
  const disabled = useRef(false);
  const retryAt = useRef(0);

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) =>
      setActive(state === 'active'),
    );
    return () => listener.remove();
  }, []);

  useEffect(() => {
    if (!enabled || !active || disabled.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const schedule = () => {
      if (!stopped && !disabled.current)
        timer = setTimeout(
          () => void run(),
          Math.max(PROBE_INTERVAL_MS, retryAt.current - Date.now()),
        );
    };
    const run = async () => {
      if (stopped || disabled.current) return;
      if (inFlight.current || retryAt.current > Date.now()) {
        schedule();
        return;
      }
      inFlight.current = true;
      let photo: Photo | undefined;
      try {
        photo = await takeProbePhoto(cameraRef.current);
        if (stopped) return;
        const document = await mutateAsync({
          image: toUploadFile(photo),
          signal: controller.signal,
        });
        if (!stopped)
          setProbe({
            document,
            imageSize: { width: photo.width, height: photo.height },
          });
      } catch (error) {
        // Persist server backoff even when a result or sheet interrupted this request.
        if (
          isApiError(error) &&
          error.status === 503 &&
          error.code === 'ocr_unavailable'
        ) {
          disabled.current = true;
          setProbe(null);
        } else if (isApiError(error) && error.status === 503) {
          retryAt.current =
            Date.now() + (error.retryAfterMs ?? PROBE_INTERVAL_MS);
          setProbe(null);
        } else if (isApiError(error) && error.status === 429) {
          retryAt.current = Date.now() + (error.retryAfterMs ?? 60_000);
          setProbe(null);
        }
      } finally {
        if (photo) discardProbePhoto(photo.uri);
        inFlight.current = false;
        schedule();
      }
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [cameraRef, enabled, active, mutateAsync]);

  return enabled && active ? probe : null;
}
