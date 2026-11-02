import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraPermission,
  useFrameOutput,
  usePhotoOutput,
  type Frame,
} from 'react-native-vision-camera';
import {
  useBarcodeScannerOutput,
  type TargetBarcodeFormat,
} from 'react-native-vision-camera-barcode-scanner';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  createSynchronizable,
  scheduleOnRN,
  scheduleOnUI,
} from 'react-native-worklets';
import {
  createObjectDetector,
  type ObjectDetector,
} from '@taphoa/mlkit-object-detection';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { captureException } from '@/lib/analyticsBridge';
import { discardProbePhoto } from './capture';
import type { CameraPreviewProps } from './CameraPreview.types';
import {
  mapBoxToPreview,
  type FrameGeometry,
  type Rotation,
} from './vision/geometry';
import { createTracker, trackObjects, type TrackedBox } from './vision/tracker';
import {
  createStability,
  normalizeBoxes,
  updateStability,
} from './vision/identify';

const FORMATS: TargetBarcodeFormat[] = [
  'ean-13',
  'ean-8',
  'upc-a',
  'upc-e',
  'code-128',
  'qr-code',
];
const RESOLUTION = { width: 1280, height: 960 };
const SLOTS = [0, 1, 2, 3, 4];

export function useCameraPermissions() {
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  return [
    { granted: hasPermission, canAskAgain: canRequestPermission },
    requestPermission,
  ] as const;
}

function LiveBox({
  index,
  boxes,
}: {
  index: number;
  boxes: SharedValue<TrackedBox[]>;
}) {
  const animated = useAnimatedStyle(() => {
    const box = boxes.value[index];
    return {
      opacity: box ? 1 : 0,
      left: box?.x ?? 0,
      top: box?.y ?? 0,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
    };
  });
  return (
    <Animated.View
      testID={`live-object-${index}`}
      pointerEvents="none"
      style={[styles.box, animated]}
    />
  );
}

/** One mounted camera; mode changes replace outputs, avoiding Android SurfaceView leaks (#4180). */
export function CameraPreview({
  cameraRef,
  active,
  codeMode,
  detectionEnabled,
  autoIdentify,
  onAutoCapture,
  onReadyChange,
  onBarcodeScanned,
}: CameraPreviewProps) {
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [detector, setDetector] = useState<ObjectDetector | null>(null);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    let instance: ObjectDetector | null = null;
    try {
      instance = createObjectDetector();
    } catch (error) {
      captureException(error, { feature: 'camera_detector' });
    }
    // Ownership starts at commit; StrictMode closes the exact instance created by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetector(instance);
    return () => instance?.dispose();
  }, []);

  const boxes = useSharedValue<TrackedBox[]>([]);
  const layout = useMemo(
    () => createSynchronizable({ width: 0, height: 0 }),
    [],
  );
  const control = useMemo(
    () => createSynchronizable({ detect: false, auto: false, scan: false }),
    [],
  );
  const processing = useMemo(
    () =>
      createSynchronizable({
        tracker: createTracker(),
        stability: createStability(),
        objects: [] as TrackedBox[],
        geometry: { width: 0, height: 0, rotation: 0 } as FrameGeometry,
        at: 0,
      }),
    [],
  );
  const autoHandler = useRef(onAutoCapture);
  const barcodeHandler = useRef(onBarcodeScanned);
  useEffect(() => {
    autoHandler.current = onAutoCapture;
    barcodeHandler.current = onBarcodeScanned;
  }, [onAutoCapture, onBarcodeScanned]);
  const trigger = useCallback(() => {
    const current = control.getBlocking();
    if (current.detect && current.auto) autoHandler.current();
  }, [control]);
  useEffect(() => {
    control.setBlocking({
      detect: active && foreground && detectionEnabled && !codeMode,
      auto: autoIdentify,
      scan: active && foreground && codeMode,
    });
  }, [active, foreground, detectionEnabled, codeMode, autoIdentify, control]);

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      try {
        const enabled = control.getBlocking();
        if (!detector || !enabled.detect) return;
        const metadata = detector.getFrameMetadata(frame);
        const previous = processing.getBlocking();
        const tracked = trackObjects(
          previous.tracker,
          detector.detectObjects(frame).slice(0, 5),
        );
        const now = Date.now();
        const geometry = {
          width: metadata.width,
          height: metadata.height,
          rotation: metadata.rotation as Rotation,
        };
        const stable = updateStability(
          previous.stability,
          tracked.objects,
          now,
          enabled.auto,
        );
        processing.setBlocking({
          tracker: tracked.state,
          stability: stable.state,
          objects: tracked.objects,
          geometry,
          at: now,
        });
        const view = layout.getBlocking();
        const mapped: TrackedBox[] = [];
        for (const box of tracked.objects) {
          const projected = mapBoxToPreview(
            box,
            geometry,
            view,
            metadata.isMirrored,
          );
          if (projected) mapped.push({ ...box, ...projected });
        }
        scheduleOnUI(() => {
          boxes.value = mapped;
        });
        if (stable.trigger) scheduleOnRN(trigger);
      } catch {
        const previous = processing.getBlocking();
        processing.setBlocking({
          ...previous,
          objects: [],
          at: 0,
          stability: createStability(),
        });
        scheduleOnUI(() => {
          boxes.value = [];
        });
      } finally {
        frame.dispose();
      }
    },
    [boxes, control, detector, layout, processing, trigger],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    targetResolution: RESOLUTION,
    onFrame,
    onFrameDropped: () => {},
  });
  const photoOutput = usePhotoOutput({
    targetResolution: RESOLUTION,
    containerFormat: 'jpeg',
    quality: 0.6,
  });
  const barcodeOutput = useBarcodeScannerOutput({
    barcodeFormats: FORMATS,
    onBarcodeScanned: (codes) => {
      if (!control.getBlocking().scan) return;
      for (const code of codes) {
        if (code.rawValue)
          barcodeHandler.current?.({ data: code.rawValue, type: code.format });
      }
    },
    onError: (error) => captureException(error, { feature: 'camera_barcode' }),
  });
  const outputs = useMemo(
    () => (codeMode ? [barcodeOutput] : [photoOutput, frameOutput]),
    [codeMode, barcodeOutput, photoOutput, frameOutput],
  );
  useEffect(
    () => () => {
      frameOutput.dispose();
      photoOutput.dispose();
      barcodeOutput.dispose();
      onReadyChange(false);
    },
    [frameOutput, photoOutput, barcodeOutput, onReadyChange],
  );

  useImperativeHandle(
    cameraRef,
    () => ({
      async takePictureAsync(options) {
        // Copy the latest live boxes before capture changes the outputs or freezes the view.
        const latest = processing.getBlocking();
        const capturedBoxes =
          Date.now() - latest.at <= 1000
            ? normalizeBoxes(latest.objects, latest.geometry)
            : [];
        const photo = await photoOutput.capturePhotoToFile(
          {
            flashMode: 'off',
            enableShutterSound: options.shutterSound !== false,
          },
          {},
        );
        const uri = `file://${photo.filePath}`;
        try {
          // SDK 58's bounded loader decodes EXIF orientation. Saving produces upright JPEG pixels.
          const image = await ImageManipulator.manipulate(uri, {
            maxWidth: 1280,
            maxHeight: 1280,
          }).renderAsync();
          const saved = await image.saveAsync({
            format: SaveFormat.JPEG,
            compress: 0.6,
          });
          const sideways = latest.geometry.rotation % 180 !== 0;
          const frameAspect = sideways
            ? latest.geometry.height / latest.geometry.width
            : latest.geometry.width / latest.geometry.height;
          // Rotation changes or OEM crop negotiation can invalidate a shutter-time box.
          // Let the server segment the image when its field of view no longer aligns.
          const aligned =
            Math.abs(Math.log(saved.width / saved.height / frameAspect)) < 0.03;
          return {
            uri: saved.uri,
            width: saved.width,
            height: saved.height,
            boxes: aligned ? capturedBoxes : [],
          };
        } finally {
          discardProbePhoto(uri);
        }
      },
    }),
    [photoOutput, processing],
  );

  const ready = useCallback(() => onReadyChange(true), [onReadyChange]);
  const stopped = useCallback(() => onReadyChange(false), [onReadyChange]);
  return (
    <PostHogMaskView style={StyleSheet.absoluteFill}>
      <View
        testID="camera-view"
        style={StyleSheet.absoluteFill}
        onLayout={({ nativeEvent }) =>
          layout.setBlocking({
            width: nativeEvent.layout.width,
            height: nativeEvent.layout.height,
          })
        }
      >
        <Camera
          nativeID="vision-camera"
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={active && foreground}
          outputs={outputs}
          resizeMode="cover"
          implementationMode="compatible"
          orientationSource="interface"
          onPreviewStarted={ready}
          onPreviewStopped={stopped}
          onError={(error) => {
            stopped();
            captureException(error, { feature: 'camera_preview' });
          }}
        />
        {detectionEnabled && !codeMode
          ? SLOTS.map((index) => (
              <LiveBox key={index} index={index} boxes={boxes} />
            ))
          : null}
      </View>
    </PostHogMaskView>
  );
}
const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#65ff9d',
    borderRadius: 8,
  },
});
