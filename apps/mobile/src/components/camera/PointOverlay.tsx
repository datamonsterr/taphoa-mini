import { Image } from 'expo-image';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  MIN_SHOTS,
  type QuickPoint,
  type Shot,
} from '@/features/camera/quickEnroll';
import { camera, colors, radius, size, space, typography } from '@/theme';

export type PointOverlayProps = {
  shot: Shot;
  index: number;
  acceptedCount: number;
  onTap: (point: QuickPoint) => void;
  onUndo: () => void;
  onRetake: () => void;
  onNext: () => void;
};

type Dimensions = { width: number; height: number };
type Point = { x: number; y: number };

/** Centred image geometry, shared by the tap and marker transforms. */
function photoRect(
  view: Dimensions,
  photo: Dimensions,
  fit: 'contain' | 'cover',
) {
  const scale = (fit === 'contain' ? Math.min : Math.max)(
    view.width / photo.width,
    view.height / photo.height,
  );
  return {
    scale,
    left: (view.width - photo.width * scale) / 2,
    top: (view.height - photo.height * scale) / 2,
    width: photo.width * scale,
    height: photo.height * scale,
  };
}

/** Convert a tap in the view to original photo pixels; ignore the letterbox. */

export function viewToPhoto(
  tap: Point,
  view: Dimensions,
  photo: Dimensions,
  fit: 'contain' | 'cover',
): Point | null {
  if (
    view.width <= 0 ||
    view.height <= 0 ||
    photo.width <= 0 ||
    photo.height <= 0 ||
    tap.x < 0 ||
    tap.x > view.width ||
    tap.y < 0 ||
    tap.y > view.height
  )
    return null;
  const { scale, left, top } = photoRect(view, photo, fit);
  const x = (tap.x - left) / scale;
  const y = (tap.y - top) / scale;
  if (x < 0 || x > photo.width || y < 0 || y > photo.height) return null;
  return { x, y };
}

export function PointOverlay({
  shot,
  index,
  acceptedCount,
  onTap,
  onUndo,
  onRetake,
  onNext,
}: PointOverlayProps) {
  const [view, setView] = useState<Dimensions>({ width: 0, height: 0 });
  const { scale, ...rect } = photoRect(view, shot, 'contain');
  const hasLayout = view.width > 0 && view.height > 0;
  const currentDot = Math.min(index, MIN_SHOTS - 1);
  return (
    <View style={[StyleSheet.absoluteFill, styles.overlay]}>
      <Pressable
        testID="point-overlay-canvas"
        accessibilityLabel="Chạm vào sản phẩm để tách nền"
        style={StyleSheet.absoluteFill}
        onLayout={({ nativeEvent: { layout } }) =>
          setView({ width: layout.width, height: layout.height })
        }
        onPress={({ nativeEvent: { locationX, locationY } }) => {
          const point = viewToPhoto(
            { x: locationX, y: locationY },
            view,
            shot,
            'contain',
          );
          if (point) onTap({ ...point, label: 1 });
        }}
      >
        <Image
          testID="point-overlay-photo"
          pointerEvents="none"
          source={{ uri: shot.uri }}
          contentFit="contain"
          style={StyleSheet.absoluteFill}
        />
        {shot.mask && hasLayout ? (
          <Image
            testID="point-overlay-mask"
            pointerEvents="none"
            source={{ uri: `data:image/png;base64,${shot.mask.pngBase64}` }}
            contentFit="fill"
            tintColor={colors.accent}
            style={[styles.mask, rect]}
          />
        ) : null}
        {hasLayout
          ? shot.points.map((point, i) => (
              <View
                key={i}
                testID="point-marker"
                accessibilityLabel={`Điểm ${i + 1}`}
                pointerEvents="none"
                style={[
                  styles.marker,
                  {
                    left: rect.left + point.x * scale - MARKER_RADIUS,
                    top: rect.top + point.y * scale - MARKER_RADIUS,
                  },
                ]}
              />
            ))
          : null}
      </Pressable>
      <SafeAreaView
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, styles.chrome]}
      >
        <View pointerEvents="none" style={styles.hint}>
          <Text style={styles.hintText}>Xoay sản phẩm</Text>
          <View style={styles.progress}>
            {Array.from({ length: MIN_SHOTS }, (_, i) => (
              <View
                key={i}
                accessible
                testID="angle-dot"
                accessibilityLabel={`Góc ${i + 1}: ${i < acceptedCount ? 'đã chụp' : 'chưa chụp'}`}
                accessibilityState={{ selected: i === currentDot }}
                style={[
                  styles.dot,
                  {
                    backgroundColor:
                      i < acceptedCount ? colors.accent : 'transparent',
                    borderColor:
                      i === currentDot ? colors.accent : colors.cameraMuted,
                  },
                ]}
              />
            ))}
          </View>
          {shot.status === 'segmenting' ? (
            <View style={styles.waiting}>
              <ActivityIndicator
                accessible
                accessibilityRole="progressbar"
                color={colors.onAccent}
              />
              <Text accessibilityLiveRegion="polite" style={styles.caption}>
                Đang tách...
              </Text>
            </View>
          ) : null}
          {shot.status === 'error' ? (
            <View accessible accessibilityRole="alert">
              <Text selectable style={styles.caption}>
                {shot.error}
              </Text>
              <Text style={styles.caption}>
                Chạm lại vào sản phẩm để thử lại.
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.actions}>
          {[
            {
              label: 'Hoàn tác điểm',
              onPress: onUndo,
              disabled: shot.points.length === 0,
            },
            { label: 'Chụp lại', onPress: onRetake, disabled: false },
            {
              label: 'Tiếp',
              onPress: onNext,
              primary: true,
              disabled: !shot.mask || shot.status !== 'pointing',
            },
          ].map(({ label, onPress, disabled, primary }) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={onPress}
              style={[
                styles.button,
                primary && styles.primary,
                disabled && styles.disabled,
              ]}
            >
              <Text style={[styles.caption, styles.buttonText]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </View>
  );
}

const MARKER_RADIUS = 12;

const styles = StyleSheet.create({
  overlay: { backgroundColor: colors.cameraBg },
  mask: { position: 'absolute', opacity: 0.35 },
  marker: {
    position: 'absolute',
    width: MARKER_RADIUS * 2,
    height: MARKER_RADIUS * 2,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.onAccent,
  },
  chrome: { justifyContent: 'space-between', padding: space[4] },
  hint: {
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    backgroundColor: camera.pillDark,
    borderRadius: radius.md,
  },
  hintText: { ...typography.label, color: colors.cameraInk },
  progress: { flexDirection: 'row', gap: space[3] },
  dot: { width: 14, height: 14, borderRadius: radius.full, borderWidth: 2 },
  waiting: { flexDirection: 'row', gap: space[2], alignItems: 'center' },
  caption: { ...typography.caption, color: colors.cameraInk },
  actions: { flexDirection: 'row', gap: space[2] },
  button: {
    flex: 1,
    minHeight: size.tapMin,
    borderRadius: radius.sm,
    padding: space[2],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: camera.glass,
  },
  primary: { backgroundColor: colors.accent },
  disabled: { opacity: 0.4 },
  buttonText: { textAlign: 'center' },
});
