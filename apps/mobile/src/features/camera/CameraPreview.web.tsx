import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { CameraView } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import { useEffect, useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { CODE_SETTINGS } from './barcode';
import type { CameraPreviewProps } from './CameraPreview.types';
export { useCameraPermissions } from 'expo-camera';
export const supportsOneTripEnrollment = false;
/**
 * The live preview. It reports readiness once `expo-camera` has started, and not-ready when it
 * unmounts (behind a frozen photo, off screen), so the shutter never fires into a cold camera.
 *
 * In Code mode the Expo handler stays stable while reads are paused.
 */
export function CameraPreview({
  cameraRef,
  onReadyChange,
  onBarcodeScanned,
  codeMode,
  active,
}: CameraPreviewProps) {
  useEffect(() => () => onReadyChange(false), [onReadyChange]);
  const onCameraReady = useCallback(() => onReadyChange(true), [onReadyChange]);
  const barcodeHandler = useRef(onBarcodeScanned);
  useEffect(() => {
    barcodeHandler.current = onBarcodeScanned;
  }, [onBarcodeScanned]);
  const onBarcode = useCallback(
    (result: BarcodeScanningResult) => barcodeHandler.current?.(result),
    [],
  );
  useEffect(() => {
    if (!active) onReadyChange(false);
  }, [active, onReadyChange]);
  if (!active) return null;
  return (
    <PostHogMaskView style={StyleSheet.absoluteFill}>
      <CameraView
        ref={cameraRef as React.RefObject<CameraView | null>}
        facing="back"
        animateShutter={false}
        barcodeScannerSettings={CODE_SETTINGS}
        onBarcodeScanned={codeMode ? onBarcode : undefined}
        onCameraReady={onCameraReady}
        style={StyleSheet.absoluteFill}
      />
    </PostHogMaskView>
  );
}
