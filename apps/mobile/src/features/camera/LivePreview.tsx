/* eslint-disable @typescript-eslint/no-require-imports -- native modules are optional in Expo Go. */
import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';
import { memo, useCallback, useEffect } from 'react';
import { Platform, StyleSheet, TurboModuleRegistry } from 'react-native';
import type { PictureTaker } from './capture';

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
export const LivePreview = memo(function LivePreview(props: PreviewProps) {
  if (useNativeCameraEnabled()) {
    // Keep Nitro and VisionCamera unloaded in Expo Go and on web.
    const { NativeLivePreview } =
      require('./NativeLivePreview') as typeof import('./NativeLivePreview');
    return <NativeLivePreview {...props} />;
  }
  return <ExpoLivePreview {...props} />;
});

export function useNativeCameraEnabled(): boolean {
  if (
    Platform.OS !== 'android' ||
    process.env.EXPO_PUBLIC_NATIVE_CAMERA !== '1'
  )
    return false;
  if (!TurboModuleRegistry.get('NitroModules')) return false;
  try {
    const { NitroModules } =
      require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    return (
      NitroModules.hasHybridObject('CameraFactory') &&
      NitroModules.hasHybridObject('VisionCameraMLKit')
    );
  } catch {
    return false;
  }
}

type PreviewProps = {
  cameraRef: React.RefObject<PictureTaker | null>;
  onReadyChange: (ready: boolean) => void;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
  scanningRef: React.RefObject<boolean>;
  dropHandler: boolean;
  codeMode?: boolean;
};

function ExpoLivePreview({
  cameraRef,
  onReadyChange,
  onBarcodeScanned,
  scanningRef,
  dropHandler,
}: PreviewProps) {
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
        ref={cameraRef as React.RefObject<CameraView | null>}
        facing="back"
        animateShutter={false}
        barcodeScannerSettings={BARCODE_SETTINGS}
        onBarcodeScanned={dropHandler ? undefined : onBarcode}
        onCameraReady={onCameraReady}
        style={StyleSheet.absoluteFill}
      />
    </PostHogMaskView>
  );
}
