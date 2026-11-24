import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';
import { memo, useCallback, useEffect } from 'react';
import { StyleSheet } from 'react-native';

import { BARCODE_SETTINGS } from './barcode';

/**
 * The live preview. It reports readiness once `expo-camera` has started, and not-ready when it
 * unmounts (behind a frozen photo, off screen), so the shutter never fires into a cold camera.
 *
 * The native barcode handler never changes. On Android, expo-camera rebinds CameraX whenever
 * `onBarcodeScanned` appears or disappears, and that rebind aborts a picture in flight with
 * "Failed to capture image". A paused scanner passes no handler and the reads are dropped here.
 * Web has no rebind, and its scanner decodes a full video frame on the main thread every 300 ms
 * while a handler is set, so a paused scanner there drops the handler to stop the decoding.
 *
 * Memoized with stable props (`cameraRef`, `onReadyChange`, `onBarcodeScanned`, `scanningRef`), so
 * cart edits and every other state change on the screen leave the camera alone. Whether the
 * scanner is live is read from `scanningRef`; only `dropHandler` (web alone) changes a prop.
 */
export const LivePreview = memo(function LivePreview({
  cameraRef,
  onReadyChange,
  onBarcodeScanned,
  scanningRef,
  dropHandler,
}: {
  cameraRef: React.RefObject<CameraView | null>;
  onReadyChange: (ready: boolean) => void;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
  scanningRef: React.RefObject<boolean>;
  /** Web only: unbind the handler while the scanner is paused. */
  dropHandler: boolean;
}) {
  useEffect(() => () => onReadyChange(false), [onReadyChange]);
  const onCameraReady = useCallback(() => onReadyChange(true), [onReadyChange]);
  const onBarcode = useCallback(
    (result: BarcodeScanningResult) => {
      if (scanningRef.current) onBarcodeScanned(result);
    },
    [onBarcodeScanned, scanningRef],
  );
  return (
    <PostHogMaskView style={StyleSheet.absoluteFill}>
      <CameraView
        ref={cameraRef}
        facing="back"
        animateShutter={false}
        barcodeScannerSettings={BARCODE_SETTINGS}
        onBarcodeScanned={dropHandler ? undefined : onBarcode}
        onCameraReady={onCameraReady}
        style={StyleSheet.absoluteFill}
      />
    </PostHogMaskView>
  );
});
