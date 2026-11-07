import { memo, useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';

import type { Rect } from '@/lib/bbox';
import { camera, colors, radius } from '@/theme';
import { fontFamily } from '@/theme/typography';

/** `guess`: an ambiguous top-1 nobody picked yet. Amber like `low`, but still tappable. */
export type BoxState = 'selected' | 'deselected' | 'low' | 'guess';

type Props = {
  /** Detection id, handed back to `onPress` so the parent can pass one stable callback. */
  id: string;
  box: Rect;
  state: BoxState;
  /** 1-based position among selected boxes (many mode). Omit in single mode. */
  number?: number;
  /** Product name, used for the accessibility label. */
  name: string;
  onPress: (id: string) => void;
};

const LABEL_SUFFIX: Record<BoxState, string> = {
  selected: 'đã chọn',
  deselected: 'bỏ chọn',
  low: 'chưa có trong kho',
  guess: 'bỏ chọn',
};

/** Tappable frame around a detected product. */
export const DetectionBox = memo(function DetectionBox({
  id,
  box,
  state,
  number,
  name,
  onPress,
}: Props) {
  const selected = state === 'selected';
  const emphasis = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    emphasis.value = withTiming(selected ? 1 : 0, { duration: 160 });
  }, [selected, emphasis]);
  const press = useCallback(() => onPress(id), [onPress, id]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: emphasis.value }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${LABEL_SUFFIX[state]}`}
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={press}
      style={[
        styles.hit,
        { left: box.x, top: box.y, width: box.width, height: box.height },
      ]}
    >
      <Animated.View pointerEvents="none" style={[styles.glow, glowStyle]} />
      <Animated.View
        testID="box-frame"
        pointerEvents="none"
        style={[styles.frame, FRAME[state]]}
      />
      {selected && number !== undefined ? (
        <Animated.View
          testID="box-badge"
          entering={ZoomIn.duration(160)}
          style={styles.badge}
        >
          <Text style={styles.badgeText}>{number}</Text>
        </Animated.View>
      ) : null}
      {state === 'deselected' ? (
        <Animated.View testID="box-ring" style={styles.ring} />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  hit: { position: 'absolute' },
  glow: {
    ...StyleSheet.absoluteFill,
    borderRadius: 18,
    backgroundColor: camera.accentTint,
    boxShadow: `0 0 0 4px ${camera.accentGlow}`,
  },
  frame: { ...StyleSheet.absoluteFill, borderRadius: 18 },
  badge: {
    position: 'absolute',
    left: -12,
    top: -12,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    boxShadow: `0 0 0 2px ${camera.white}`,
  },
  badgeText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    lineHeight: 28,
    color: colors.onAccent,
    fontVariant: ['tabular-nums'],
  },
  ring: {
    position: 'absolute',
    left: -12,
    top: -12,
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: camera.badgeOffLine,
    backgroundColor: camera.badgeOffFill,
  },
});

const FRAME = StyleSheet.create({
  selected: {
    borderWidth: 3,
    borderStyle: 'solid',
    borderColor: camera.white,
  },
  deselected: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: camera.boxOffLine,
  },
  low: {
    borderWidth: 3,
    borderStyle: 'dashed',
    borderColor: colors.warningSoft,
  },
  guess: {
    borderWidth: 3,
    borderStyle: 'dashed',
    borderColor: colors.warningSoft,
  },
});
