import type { CameraView } from 'expo-camera';
import { Alert } from 'react-native';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import {
  RATE_LIMIT_MESSAGE,
  isRateLimited,
  useSegmentPoints,
  type useUploadImage,
} from '@/lib/api';
import { downsizeForUpload } from '@/lib/api/downsize';
import { newUuid } from '@/lib/uuid';

import { takePhoto } from './capture';
import { quickPhotoAlert } from './quickEnrollParts';
import {
  selectCanCapture,
  selectCurrent,
  useQuickEnrollStore,
} from './quickEnroll';

type Args = {
  cameraRef: RefObject<CameraView | null>;
  canEnroll: boolean;
  cameraReady: boolean;
  focused: boolean;
  reset: () => void;
  uploadImage: ReturnType<typeof useUploadImage>['mutateAsync'];
};

/** Quick-enroll camera work: one photo per press, and point prompts sent for segmentation. */
export function useQuickCapture({
  cameraRef,
  canEnroll,
  cameraReady,
  focused,
  reset,
  uploadImage,
}: Args) {
  const dispatch = useQuickEnrollStore((s) => s.dispatch);
  const { mutateAsync: segmentPoints } = useSegmentPoints();
  const [quickCapturing, setQuickCapturing] = useState(false);
  const quickCaptureToken = useRef(0);
  const quickCapturePending = useRef(false);

  // Invalidate unfinished captures when this screen unmounts.
  useEffect(
    () => () => {
      quickCaptureToken.current += 1;
    },
    [],
  );

  /** Drop the capture in flight (its late answer is ignored) and release the busy indicator. */
  const cancelCapture = useCallback(() => {
    quickCaptureToken.current += 1;
    quickCapturePending.current = false;
    setQuickCapturing(false);
  }, []);

  // A frozen result means nothing once the seller leaves the screen.
  useEffect(() => {
    if (!focused) {
      reset();
      // Focus loss cancels camera work and releases its local busy indicator.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      cancelCapture();
    }
  }, [focused, reset, cancelCapture]);

  const segmentCurrent = useCallback(async () => {
    const shot = selectCurrent(useQuickEnrollStore.getState());
    if (!shot?.imageId || shot.points.length === 0) return;
    const points = shot.points;
    // Reducer updates replace the points array; undo/re-tap invalidates this request,
    // including when a later prompt has the same coordinates.
    const stillCurrent = () => {
      const current = selectCurrent(useQuickEnrollStore.getState());
      return current?.id === shot.id && current.points === points;
    };
    dispatch({ type: 'segmenting' });
    try {
      const result = await segmentPoints({ image_id: shot.imageId, points });
      if (!stillCurrent()) return;
      dispatch({
        type: 'segmented',
        id: shot.id,
        mask: {
          width: result.mask.width,
          height: result.mask.height,
          pngBase64: result.mask.png_base64,
        },
        bbox: result.bbox as [number, number, number, number],
        cutoutImageId: result.cutout_image_id,
      });
    } catch (error) {
      if (!stillCurrent()) return;
      dispatch({
        type: 'failed',
        id: shot.id,
        error: isRateLimited(error)
          ? RATE_LIMIT_MESSAGE
          : error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }, [dispatch, segmentPoints]);

  const captureQuickPhoto = useCallback(async () => {
    if (
      !canEnroll ||
      !cameraReady ||
      !focused ||
      quickCapturePending.current ||
      !selectCanCapture(useQuickEnrollStore.getState())
    )
      return;
    quickCapturePending.current = true;
    setQuickCapturing(true);
    const token = ++quickCaptureToken.current;
    const id = newUuid();
    let step: 'capture' | 'upload' = 'capture';
    try {
      const photo = await takePhoto(cameraRef.current);
      const downsized = await downsizeForUpload(
        photo.uri,
        photo.width,
        photo.height,
      );
      if (token !== quickCaptureToken.current) return;
      step = 'upload';
      dispatch({ type: 'captured', id, ...downsized });
      const image = await uploadImage({
        file: {
          uri: downsized.uri,
          name: 'enrollment.jpg',
          type: 'image/jpeg',
        },
        purpose: 'enrollment',
      });
      if (token !== quickCaptureToken.current) return;
      dispatch({ type: 'uploaded', id, imageId: image.id });
    } catch (error) {
      if (token !== quickCaptureToken.current) return;
      console.warn('quick_enroll.photo_failed', { step, error });
      const { title, message } = quickPhotoAlert(step, error);
      dispatch({ type: 'failed', id, error: message });
      Alert.alert(title, message);
    } finally {
      if (token === quickCaptureToken.current) {
        quickCapturePending.current = false;
        setQuickCapturing(false);
      }
    }
  }, [cameraRef, canEnroll, cameraReady, focused, dispatch, uploadImage]);
  return { quickCapturing, captureQuickPhoto, segmentCurrent, cancelCapture };
}
