import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Alert } from 'react-native';

import { isApiError, useSegmentPoints, type useUploadImage } from '@/lib/api';
import { downsizeForUpload } from '@/lib/api/downsize';
import { newUuid } from '@/lib/uuid';

import { takePhoto, type PictureTaker } from './capture';
import type { Photo } from './scanReducer';
import {
  cancelOneTrip,
  centerPoint,
  markOneTripStart,
  ONE_TRIP_GAP_MS,
  ONE_TRIP_SHOTS,
} from './oneTrip';
import { quickPhotoAlert } from './quickEnrollParts';
import { useQuickEnrollStore } from './quickEnroll';

type Args = {
  cameraRef: RefObject<PictureTaker | null>;
  canEnroll: boolean;
  cameraReady: boolean;
  focused: boolean;
  uploadImage: ReturnType<typeof useUploadImage>['mutateAsync'];
  /** All angles are taken (their cut-outs may still be on the way): open the sheet. */
  onCaptured: () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The backend answers 503 at once while its single inference slot is taken (a scan, a cut-out). */
const BUSY_TRIES = 4;
const BUSY_WAIT_MS = 400;

/**
 * One-trip capture: one press takes `ONE_TRIP_SHOTS` photos `ONE_TRIP_GAP_MS` apart. Each photo
 * uploads and is cut out from a centre point in the background, so the sheet opens as soon as
 * the last photo is taken and the seller says the name and price while the cut-outs finish.
 */
export function useOneTripCapture({
  cameraRef,
  canEnroll,
  cameraReady,
  focused,
  uploadImage,
  onCaptured,
}: Args) {
  const dispatch = useQuickEnrollStore((s) => s.dispatch);
  const { mutateAsync: segmentPoints } = useSegmentPoints();
  const [capturing, setCapturing] = useState(false);
  const token = useRef(0);
  /** Cut-outs run one at a time: the server has one inference slot. */
  const slot = useRef<Promise<unknown>>(Promise.resolve());
  const captured = useRef(onCaptured);
  useEffect(() => {
    captured.current = onCaptured;
  });

  const cancel = useCallback(() => {
    token.current += 1;
    setCapturing(false);
    cancelOneTrip();
  }, []);

  useEffect(
    () => () => {
      token.current += 1;
    },
    [],
  );
  useEffect(() => {
    // Focus loss drops the capture in flight and its late answers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!focused) cancel();
  }, [focused, cancel]);

  const process = useCallback(
    async (mine: number, photo: Photo): Promise<boolean> => {
      try {
        const downsized = await downsizeForUpload(
          photo.uri,
          photo.width,
          photo.height,
        );
        const image = await uploadImage({
          file: {
            uri: downsized.uri,
            name: 'enrollment.jpg',
            type: 'image/jpeg',
          },
          purpose: 'enrollment',
        });
        const point = centerPoint(downsized.width, downsized.height);
        const segment = async () => {
          for (let attempt = 1; ; attempt++) {
            if (mine !== token.current) throw new Error('cancelled');
            try {
              return await segmentPoints({
                image_id: image.id,
                points: [point],
              });
            } catch (error) {
              if (
                attempt >= BUSY_TRIES ||
                !isApiError(error) ||
                error.status !== 503
              )
                throw error;
              await sleep(BUSY_WAIT_MS * attempt);
            }
          }
        };
        const turn = slot.current.then(segment);
        slot.current = turn.catch(() => undefined);
        const result = await turn;
        if (mine !== token.current) return true;
        dispatch({
          type: 'auto',
          shot: {
            id: newUuid(),
            ...downsized,
            imageId: image.id,
            points: [point],
            mask: {
              width: result.mask.width,
              height: result.mask.height,
              pngBase64: result.mask.png_base64,
            },
            bbox: result.bbox as [number, number, number, number],
            cutoutImageId: result.cutout_image_id,
          },
        });
        return true;
      } catch (error) {
        console.warn('one_trip.photo_failed', error);
        return false;
      }
    },
    [dispatch, segmentPoints, uploadImage],
  );

  const start = useCallback(async () => {
    if (!canEnroll || !cameraReady || !focused || capturing) return;
    const mine = ++token.current;
    markOneTripStart();
    setCapturing(true);
    const jobs: Promise<boolean>[] = [];
    try {
      for (let shot = 0; shot < ONE_TRIP_SHOTS; shot++) {
        if (shot > 0) await sleep(ONE_TRIP_GAP_MS);
        if (mine !== token.current) return;
        const photo = await takePhoto(cameraRef.current);
        if (mine !== token.current) return;
        jobs.push(process(mine, photo));
      }
    } catch (error) {
      if (mine !== token.current) return;
      setCapturing(false);
      cancelOneTrip();
      const { title, message } = quickPhotoAlert('capture', error);
      Alert.alert(title, message);
      return;
    }
    setCapturing(false);
    captured.current();
    const results = await Promise.all(jobs);
    if (mine === token.current && results.includes(false))
      Alert.alert(
        'Có ảnh chưa tách được',
        'Bấm ô máy ảnh trong bảng để chụp thêm góc.',
      );
  }, [canEnroll, cameraReady, focused, capturing, cameraRef, process]);

  return {
    oneTripCapturing: capturing,
    startOneTrip: start,
    stopOneTrip: cancel,
  };
}
