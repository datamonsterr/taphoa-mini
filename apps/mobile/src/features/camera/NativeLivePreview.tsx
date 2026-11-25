import { useCallback, useEffect, useImperativeHandle, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import {
  Camera,
  useFrameOutput,
  usePhotoOutput,
} from 'react-native-vision-camera';
import {
  useBarcodeScanning,
  useTextRecognition,
} from 'react-native-vision-camera-mlkit';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { discardProbePhoto } from './capture';
import type { BarcodeScanningResult } from 'expo-camera';
import { PostHogMaskView } from '@/components/ui/ReplayMask';
import type { PictureTaker } from './capture';

export function NativeLivePreview({
  cameraRef,
  onReadyChange,
  onBarcodeScanned,
  scanningRef,
  codeMode = false,
}: {
  cameraRef: React.RefObject<PictureTaker | null>;
  onReadyChange: (ready: boolean) => void;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
  scanningRef: React.RefObject<boolean>;
  codeMode?: boolean;
}) {
  const { barcodeScanning } = useBarcodeScanning({
    formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128'],
  });
  const { textRecognition } = useTextRecognition({ language: 'LATIN' });
  const deliver = useCallback(
    (data: string, type: string) => {
      if (codeMode && scanningRef.current)
        onBarcodeScanned({ data, type } as BarcodeScanningResult);
    },
    [scanningRef, onBarcodeScanned, codeMode],
  );
  const codeEnabled = useMemo(() => createSynchronizable(false), []);
  useEffect(() => {
    codeEnabled.setBlocking(codeMode);
  }, [codeEnabled, codeMode]);
  const lastFrame = useMemo(() => createSynchronizable(0), []);
  const frames = useFrameOutput({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    onFrame(frame) {
      'worklet';
      try {
        if (!codeEnabled.getBlocking()) return;
        const now = Date.now();
        if (now - lastFrame.getBlocking() < 500) return;
        lastFrame.setBlocking(now);
        const result = barcodeScanning(frame);
        for (const code of result.barcodes) {
          if (code.rawValue)
            scheduleOnRN(deliver, code.rawValue, code.formatName);
        }
        if (!result.barcodes.length) {
          const text = textRecognition(frame).text;
          const match = text.match(/\b\d{6,20}\b/);
          if (match) scheduleOnRN(deliver, match[0], 'text');
        }
      } finally {
        frame.dispose();
      }
    },
  });
  const photos = usePhotoOutput({ containerFormat: 'jpeg', quality: 0.6 });
  const outputs = useMemo(() => [photos, frames], [photos, frames]);
  useImperativeHandle(
    cameraRef,
    () => ({
      async takePictureAsync(options) {
        const photo = await photos.capturePhotoToFile(
          {
            flashMode: 'off',
            enableShutterSound: options.shutterSound !== false,
          },
          {},
        );
        const uri = `file://${photo.filePath}`;
        try {
          const image = await ImageManipulator.manipulate(uri, {
            maxWidth: 1280,
            maxHeight: 1280,
          }).renderAsync();
          return await image.saveAsync({
            format: SaveFormat.JPEG,
            compress: options.quality ?? 0.6,
          });
        } finally {
          discardProbePhoto(uri);
        }
      },
    }),
    [photos],
  );
  useEffect(
    () => () => {
      frames.dispose();
      photos.dispose();
      onReadyChange(false);
    },
    [frames, photos, onReadyChange],
  );
  const ready = useCallback(() => onReadyChange(true), [onReadyChange]);
  const stopped = useCallback(() => onReadyChange(false), [onReadyChange]);
  return (
    <PostHogMaskView style={StyleSheet.absoluteFill}>
      <Camera
        style={StyleSheet.absoluteFill}
        device="back"
        isActive
        outputs={outputs}
        implementationMode="compatible"
        resizeMode="cover"
        onPreviewStarted={ready}
        onPreviewStopped={stopped}
      />
    </PostHogMaskView>
  );
}
