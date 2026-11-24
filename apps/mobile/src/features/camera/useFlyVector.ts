import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { flyVector, measuredFlyVector, type Layout } from './AddFeedback';

/** Measures the add button and the cart pill so the fly dot aims at the real pill. */
export function useFlyVector(width: number) {
  const [rects, setRects] = useState<{
    controlsY?: number;
    add?: Layout;
    bottomY?: number;
    pill?: Layout;
  }>({});
  const onControlsLayout = useCallback((e: LayoutChangeEvent) => {
    const controlsY = e.nativeEvent.layout.y;
    setRects((r) => ({ ...r, controlsY }));
  }, []);
  const onAddLayout = useCallback((e: LayoutChangeEvent) => {
    const add = e.nativeEvent.layout;
    setRects((r) => ({ ...r, add }));
  }, []);
  const onBottomLayout = useCallback((e: LayoutChangeEvent) => {
    const bottomY = e.nativeEvent.layout.y;
    setRects((r) => ({ ...r, bottomY }));
  }, []);
  const onPillLayout = useCallback((e: LayoutChangeEvent) => {
    const pill = e.nativeEvent.layout;
    setRects((r) => ({ ...r, pill }));
  }, []);
  // The fly dot aims at the measured cart pill; the board's row positions are only the fallback.
  const fly =
    rects.add &&
    rects.pill &&
    rects.controlsY !== undefined &&
    rects.bottomY !== undefined
      ? measuredFlyVector(rects.add, rects.controlsY, rects.pill, rects.bottomY)
      : flyVector(width);
  return {
    fly,
    onControlsLayout,
    onAddLayout,
    onBottomLayout,
    onPillLayout,
  };
}
