import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Camera,
  useCameraPermission,
  useFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  createSynchronizable,
  scheduleOnRuntimeWithId,
  UIRuntimeId,
} from 'react-native-worklets';
import {
  createObjectDetector,
  type ObjectDetector,
} from '@taphoa/mlkit-object-detection';
import { mapBoxToPreview, selectBoxAtPoint, type Rotation } from './geometry';
import { createTracker, trackObjects, type TrackedBox } from './tracker';

const AnimatedInput = Animated.createAnimatedComponent(TextInput);
const SLOTS = [0, 1, 2, 3, 4]; // ML Kit detects at most five objects.

function OverlayBox({
  index,
  boxes,
  locked,
}: {
  index: number;
  boxes: SharedValue<TrackedBox[]>;
  locked: SharedValue<number | null>;
}) {
  const style = useAnimatedStyle(() => {
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
  return <Animated.View pointerEvents="none" style={[styles.box, style]} />;
}

function VisionSession({ detector }: { detector: ObjectDetector }) {
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => subscription.remove();
  }, []);

  const boxes = useSharedValue<TrackedBox[]>([]);
  const locked = useSharedValue<number | null>(null);
  const fps = useSharedValue(0);
  const failure = useSharedValue('');
  const layout = useMemo(
    () => createSynchronizable({ width: 0, height: 0 }),
    [],
  );
  const processing = useMemo(
    () =>
      createSynchronizable({
        tracker: createTracker(),
        count: 0,
        since: 0,
        fps: 0,
      }),
    [],
  );

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      try {
        const metadata = detector.getFrameMetadata(frame);
        const tracked = trackObjects(
          processing.getBlocking().tracker,
          detector.detectObjects(frame),
        );
        const state = processing.getBlocking();
        const now = Date.now();
        const since = state.since || now;
        const elapsed = now - since;
        const rate =
          elapsed >= 1000 ? ((state.count + 1) * 1000) / elapsed : state.fps;
        processing.setBlocking({
          tracker: tracked.state,
          count: elapsed >= 1000 ? 0 : state.count + 1,
          since: elapsed >= 1000 ? now : since,
          fps: rate,
        });
        const view = layout.getBlocking();
        const mapped: TrackedBox[] = [];
        for (const box of tracked.objects) {
          const projected = mapBoxToPreview(
            box,
            {
              width: metadata.width,
              height: metadata.height,
              rotation: metadata.rotation as Rotation,
            },
            view,
            metadata.isMirrored,
          );
          if (projected) mapped.push({ ...box, ...projected });
        }
        // Reanimated SharedValues belong to the UI runtime. Transfer plain results
        // explicitly from the frame runtime; never set React state per frame.
        scheduleOnRuntimeWithId(UIRuntimeId, () => {
          'worklet';
          boxes.value = mapped;
          fps.value = rate;
          failure.value = '';
          if (
            locked.value !== null &&
            !tracked.state.tracks.some((track) => track.id === locked.value)
          )
            locked.value = null;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        scheduleOnRuntimeWithId(UIRuntimeId, () => {
          'worklet';
          failure.value = message;
          boxes.value = [];
        });
      } finally {
        frame.dispose();
      }
    },
    [boxes, detector, failure, fps, layout, locked, processing],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    targetResolution: { width: 1280, height: 720 },
    onFrame,
    onFrameDropped: () => {},
  });
  const outputs = useMemo(() => [frameOutput], [frameOutput]);
  useEffect(() => () => frameOutput.dispose(), [frameOutput]);

  const statusProps = useAnimatedProps(() => {
    const text =
      failure.value ||
      `${fps.value.toFixed(1)} detection fps · ${boxes.value.length} boxes · ${locked.value === null ? 'tap to lock' : `locked #${locked.value}`}`;
    return { text, defaultValue: text };
  });

  return (
    <View style={styles.root}>
      <View
        style={styles.preview}
        onLayout={({ nativeEvent }) =>
          layout.setBlocking({
            width: nativeEvent.layout.width,
            height: nativeEvent.layout.height,
          })
        }
      >
        <Camera
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={focused && foreground}
          outputs={outputs}
          resizeMode="cover"
          implementationMode="compatible"
          orientationSource="interface"
        />
        <Pressable
          accessibilityLabel="Tap an object to lock, or empty space to unlock"
          style={StyleSheet.absoluteFill}
          onPress={({ nativeEvent }) => {
            const { locationX, locationY } = nativeEvent;
            scheduleOnRuntimeWithId(UIRuntimeId, () => {
              'worklet';
              locked.value =
                selectBoxAtPoint(boxes.value, { x: locationX, y: locationY })
                  ?.id ?? null;
            });
          }}
        >
          {SLOTS.map((index) => (
            <OverlayBox
              key={index}
              index={index}
              boxes={boxes}
              locked={locked}
            />
          ))}
        </Pressable>
      </View>
      <AnimatedInput
        style={styles.status}
        editable={false}
        animatedProps={statusProps}
        accessibilityLabel="Detection status"
      />
      <Text style={styles.hint}>
        ML Kit stream · Android spike · first boxes can take 30+ frames. Tap
        empty space to unlock.
      </Text>
    </View>
  );
}

function AndroidVisionScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [{ detector, error }, setNative] = useState<{
    detector: ObjectDetector | null;
    error: string;
  }>({ detector: null, error: '' });
  useEffect(() => {
    let instance: ObjectDetector | null = null;
    let error = '';
    try {
      instance = createObjectDetector();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    // Native ownership starts at commit, so StrictMode cleanup closes this exact instance.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNative({ detector: instance, error });
    return () => instance?.dispose();
  }, []);
  if (error)
    return (
      <View style={styles.root}>
        <Text style={styles.hint}>{error}</Text>
      </View>
    );
  if (!hasPermission)
    return (
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void requestPermission()}
        >
          <Text style={styles.hint}>Allow camera access</Text>
        </Pressable>
      </View>
    );
  return detector ? <VisionSession detector={detector} /> : null;
}

export default function VisionDevScreen() {
  if (Platform.OS !== 'android')
    return (
      <View style={styles.root}>
        <Text style={styles.hint}>
          Object detection is Android only in this spike.
        </Text>
      </View>
    );
  return <AndroidVisionScreen />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#101014',
    paddingTop: 40,
    paddingBottom: 24,
  },
  preview: { flex: 1, overflow: 'hidden' },
  box: { position: 'absolute', borderRadius: 8 },
  status: { color: '#fff', padding: 12, fontSize: 14 },
  hint: { color: '#ddd', paddingHorizontal: 12, paddingVertical: 8 },
});
