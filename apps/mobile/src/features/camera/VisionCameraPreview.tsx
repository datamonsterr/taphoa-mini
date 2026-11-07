import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraPermission,
  useFrameOutput,
  usePhotoOutput,
  useAsyncRunner,
  HybridFrameConverter,
  type Frame,
} from 'react-native-vision-camera';
import {
  createResizer,
  type Resizer,
} from 'react-native-vision-camera-resizer';
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
  scheduleOnRuntimeWithId,
  UIRuntimeId,
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
  selectBoxAtPoint,
  type FrameGeometry,
  type Rotation,
} from './vision/geometry';
import { createTracker, trackObjects, type TrackedBox } from './vision/tracker';
import {
  createStability,
  normalizeBoxes,
  updateStability,
} from './vision/identify';
import {
  boxLumaThumbnail,
  EVALUATE_MS,
  MAX_KEYFRAMES,
  selectLockedTrack,
  shouldKeepKeyframe,
  type EnrollmentControl,
  type Keyframe,
  type KeyframeSample,
} from './vision/enrollment';

export const supportsOneTripEnrollment = Platform.OS === 'android';

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
  locked,
}: {
  index: number;
  boxes: SharedValue<TrackedBox[]>;
  locked: SharedValue<number | null>;
}) {
  const animated = useAnimatedStyle(() => {
    const box = boxes.value[index];
    return {
      opacity: box ? 1 : 0,
      left: box?.x ?? 0,
      top: box?.y ?? 0,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      borderColor: box?.id === locked.value ? '#ffdc55' : '#65ff9d',
      borderWidth: box?.id === locked.value ? 4 : 2,
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
  enrollment,
  onEnrollmentStart,
  onEnrollmentFrame,
  onEnrollmentTrack,
}: CameraPreviewProps) {
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [detector, setDetector] = useState<ObjectDetector | null>(null);
  const [resizer, setResizer] = useState<Resizer | null>(null);
  const runner = useAsyncRunner();
  useEffect(() => {
    let disposed = false;
    let owned: Resizer | undefined;
    void createResizer({
      width: 160,
      height: 160,
      channelOrder: 'rgb',
      dataType: 'uint8',
      pixelLayout: 'interleaved',
      scaleMode: 'stretch',
    })
      .then((instance) => {
        if (disposed) {
          instance.dispose();
          return;
        }
        owned = instance;
        setResizer(instance);
      })
      .catch((error) =>
        captureException(error, { feature: 'enrollment_resizer' }),
      );
    return () => {
      disposed = true;
      const release = () => {
        if (runner.isBusy()) setTimeout(release, 100);
        else owned?.dispose();
      };
      release();
    };
  }, [runner]);
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
  const lockedId = useSharedValue<number | null>(null);
  const layout = useMemo(
    () => createSynchronizable({ width: 0, height: 0 }),
    [],
  );
  const control = useMemo(
    () =>
      createSynchronizable({
        detect: false,
        auto: false,
        scan: false,
        enrollment: undefined as EnrollmentControl | undefined,
      }),
    [],
  );
  const enrolling = useMemo(
    () =>
      createSynchronizable({
        id: -1,
        locked: null as TrackedBox | null,
        lastSeen: 0,
        evaluated: 0,
      }),
    [],
  );
  // Tracking writes belong to the frame thread; sample/encode writes belong to the async runtime.
  // Separate cells prevent a frame's read-modify-write from overwriting an encode completion.
  const sampling = useMemo(
    () =>
      createSynchronizable({
        id: -1,
        last: null as KeyframeSample | null,
        count: 0,
        saving: false,
      }),
    [],
  );
  const enrollmentHandlers = useRef({
    onEnrollmentStart,
    onEnrollmentFrame,
    onEnrollmentTrack,
  });
  useEffect(() => {
    enrollmentHandlers.current = {
      onEnrollmentStart,
      onEnrollmentFrame,
      onEnrollmentTrack,
    };
  });
  const deliverFrame = useCallback(
    (id: number, frame: Keyframe) => {
      if (control.getBlocking().enrollment?.id !== id) {
        discardProbePhoto(frame.uri);
        return;
      }
      enrollmentHandlers.current.onEnrollmentFrame?.(id, frame);
    },
    [control],
  );
  const deliverTrack = useCallback(
    (id: number, seen: number) =>
      enrollmentHandlers.current.onEnrollmentTrack?.(id, seen),
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
      enrollment,
    });
  }, [
    active,
    foreground,
    detectionEnabled,
    codeMode,
    autoIdentify,
    control,
    enrollment,
  ]);

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      let transferred = false;
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
        scheduleOnRuntimeWithId(UIRuntimeId, () => {
          'worklet';
          boxes.value = mapped;
        });
        if (stable.trigger) scheduleOnRN(trigger);
        const capture = enabled.enrollment;
        if (!capture?.capturing && !capture?.armed)
          scheduleOnRuntimeWithId(UIRuntimeId, () => {
            'worklet';
            lockedId.value = null;
          });
        const session = enrolling.getBlocking();
        if (
          !capture?.capturing ||
          session.id !== capture.id ||
          !session.locked ||
          now - session.evaluated < EVALUATE_MS
        )
          return;
        const locked = selectLockedTrack(tracked.objects, session.locked);
        if (locked)
          scheduleOnRuntimeWithId(UIRuntimeId, () => {
            'worklet';
            lockedId.value = locked.id;
          });
        const next = {
          ...session,
          evaluated: now,
          locked: locked ?? session.locked,
          lastSeen: locked ? now : session.lastSeen,
        };
        enrolling.setBlocking((latest) => {
          'worklet';
          return latest.id === session.id ? next : latest;
        });
        scheduleOnRN(deliverTrack, capture.id, next.lastSeen);
        const quality = sampling.getBlocking();
        if (
          !locked ||
          !resizer ||
          quality.id !== capture.id ||
          quality.saving ||
          quality.count >= MAX_KEYFRAMES
        )
          return;
        const box = normalizeBoxes([locked], geometry)[0];
        if (!box) return;
        transferred = runner.runAsync(() => {
          'worklet';
          try {
            const current = control.getBlocking();
            if (
              !current.detect ||
              !current.enrollment?.capturing ||
              current.enrollment.id !== capture.id
            )
              return;
            const thumb = resizer.resize(frame);
            let luma: number[];
            try {
              luma = boxLumaThumbnail(
                new Uint8Array(thumb.getPixelBuffer()),
                thumb.width,
                thumb.height,
                box,
              );
            } finally {
              thumb.dispose();
            }
            const sample = { box, luma };
            if (!shouldKeepKeyframe(sample, sampling.getBlocking().last))
              return;
            // CPU conversion, resize and encoding belong to this async runner, never the frame thread.
            // convertFrameToImage physically applies orientation/mirroring (pinned v5.2.4 implementation).
            const image = HybridFrameConverter.convertFrameToImage(frame);
            const scale = Math.min(
              1,
              1024 / Math.max(image.width, image.height),
            );
            let upright = image;
            try {
              if (scale < 1)
                upright = image.resize(
                  Math.round(image.width * scale),
                  Math.round(image.height * scale),
                );
              const width = upright.width;
              const height = upright.height;
              sampling.setBlocking((latest) => {
                'worklet';
                return latest.id === capture.id
                  ? { ...latest, saving: true }
                  : latest;
              });
              void upright
                .saveToTemporaryFileAsync('jpg', 70)
                .then((path) => {
                  'worklet';
                  sampling.setBlocking((latest) => {
                    'worklet';
                    return latest.id === capture.id
                      ? {
                          ...latest,
                          last: sample,
                          count: latest.count + 1,
                          saving: false,
                        }
                      : latest;
                  });
                  scheduleOnRN(deliverFrame, capture.id, {
                    uri: `file://${path}`,
                    width,
                    height,
                    bbox: {
                      x: box.x,
                      y: box.y,
                      width: box.width,
                      height: box.height,
                    },
                  });
                })
                .catch(() => {
                  'worklet';
                  sampling.setBlocking((latest) => {
                    'worklet';
                    return latest.id === capture.id
                      ? { ...latest, saving: false }
                      : latest;
                  });
                })
                .finally(() => {
                  'worklet';
                  if (upright !== image) upright.dispose();
                  image.dispose();
                });
            } catch {
              if (upright !== image) upright.dispose();
              image.dispose();
              sampling.setBlocking((latest) => {
                'worklet';
                return latest.id === capture.id
                  ? { ...latest, saving: false }
                  : latest;
              });
            }
          } catch {
            // A failed GPU resize/conversion must not strand the runner in its busy state.
          } finally {
            frame.dispose();
          }
        });
      } catch {
        const previous = processing.getBlocking();
        processing.setBlocking({
          ...previous,
          objects: [],
          at: 0,
          stability: createStability(),
        });
        scheduleOnRuntimeWithId(UIRuntimeId, () => {
          'worklet';
          boxes.value = [];
        });
      } finally {
        if (!transferred) frame.dispose();
      }
    },
    [
      boxes,
      lockedId,
      control,
      detector,
      layout,
      processing,
      trigger,
      enrolling,
      sampling,
      resizer,
      runner,
      deliverFrame,
      deliverTrack,
    ],
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
              <LiveBox
                key={index}
                index={index}
                boxes={boxes}
                locked={lockedId}
              />
            ))
          : null}
        {enrollment?.armed && detectionEnabled && !codeMode ? (
          <Pressable
            testID="one-trip-lock"
            accessibilityRole="button"
            accessibilityLabel="Chạm vào khung sản phẩm"
            style={StyleSheet.absoluteFill}
            onPress={({ nativeEvent }) => {
              const latest = processing.getBlocking();
              if (
                !control.getBlocking().detect ||
                Date.now() - latest.at > 1000
              )
                return;
              const mapped = latest.objects.flatMap((box) => {
                const projected = mapBoxToPreview(
                  box,
                  latest.geometry,
                  layout.getBlocking(),
                );
                return projected ? [{ ...box, ...projected }] : [];
              });
              const selected = selectBoxAtPoint(mapped, {
                x: nativeEvent.locationX,
                y: nativeEvent.locationY,
              });
              const locked = latest.objects.find(
                (box) => box.id === selected?.id,
              );
              if (!locked) return;
              scheduleOnRuntimeWithId(UIRuntimeId, () => {
                'worklet';
                lockedId.value = locked.id;
              });
              enrolling.setBlocking({
                id: enrollment.id,
                locked,
                evaluated: 0,
                lastSeen: Date.now(),
              });
              sampling.setBlocking({
                id: enrollment.id,
                last: null,
                count: 0,
                saving: false,
              });
              enrollmentHandlers.current.onEnrollmentStart?.();
            }}
          />
        ) : null}
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
