import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Scan } from '@/lib/api';

import { BOARD_VIEWFINDER, FIXED_HEIGHT } from './cameraStyles';
import { toOverlayDetections } from './detections';
import { isLowMatch } from './matching';
import type { Photo } from './scanReducer';

type Args = {
  scan: Scan | null | undefined;
  photo: Photo | null | undefined;
  chosen: Record<string, string>;
  selected: Record<string, boolean>;
  openId: string | null | undefined;
  fallbackName: string;
};

/** What the board shows for a scan: viewfinder size, overlay boxes, batch size, the open box. */
export function useScanView({
  scan,
  photo,
  chosen,
  selected,
  openId,
  fallbackName,
}: Args) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const finder = Math.max(
    0,
    Math.min(
      BOARD_VIEWFINDER,
      width - 32,
      height -
        FIXED_HEIGHT -
        Math.max(insets.top, 0) -
        Math.max(insets.bottom - 32, 0),
    ),
  );
  const viewSize = useMemo(() => ({ width: finder, height: finder }), [finder]);

  const detections = useMemo(
    () => (scan ? toOverlayDetections(scan, chosen, fallbackName) : []),
    [scan, chosen, fallbackName],
  );
  // `Image.width/height` are optional in the API and the backend omits them: the boxes are in
  // pixels of the uploaded photo, whose size the camera reported.
  const imageSize = useMemo(
    () => ({
      width: scan?.image.width ?? photo?.width ?? 0,
      height: scan?.image.height ?? photo?.height ?? 0,
    }),
    [scan, photo],
  );
  const batch = useMemo(
    () => detections.filter((d) => selected[d.id] && !d.lowMatch).length,
    [detections, selected],
  );
  const anyLow = useMemo(
    () => !!scan && scan.detections.some(isLowMatch),
    [scan],
  );
  const openDetection = detections.find((d) => d.id === openId);
  return {
    finder,
    viewSize,
    detections,
    imageSize,
    batch,
    anyLow,
    openDetection,
  };
}
