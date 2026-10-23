import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { colors, radius } from '@/theme';

export type Layout = { x: number; y: number; width: number; height: number };

/**
 * Vector from the `+` slot to the cart pill, from `onLayout` rects. Each rect is relative to its
 * row; `addRowY` / `pillRowY` are those rows' tops, and both rows start at x = 0.
 */
export function measuredFlyVector(
  add: Layout,
  addRowY: number,
  pill: Layout,
  pillRowY: number,
) {
  return {
    dx: pill.x + pill.width / 2 - (add.x + add.width / 2),
    dy:
      pillRowY + pill.y + pill.height / 2 - (addRowY + add.y + add.height / 2),
  };
}

/** Fallback before layout: the board's row positions (390 wide). */
export function flyVector(screenWidth: number) {
  const gap = (screenWidth - 216) / 3;
  const addCenter = screenWidth - gap / 2 - 32;
  const pillCenter = 16 + 64;
  return { dx: pillCenter - addCenter, dy: 162 };
}

const DURATION = 420;
const DOT = 20;

type DotProps = { dx: number; dy: number; onDone: () => void };

/** Accent dot that arcs from `+` to the cart pill, then removes itself. */
const FlyDot = memo(function FlyDot({ dx, dy, onDone }: DotProps) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: DURATION });
    const timer = setTimeout(onDone, DURATION + 40);
    return () => clearTimeout(timer);
  }, [progress, onDone]);
  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.value * 0.3,
    transform: [
      { translateX: dx * progress.value },
      {
        translateY:
          dy * progress.value - Math.sin(progress.value * Math.PI) * 60,
      },
      { scale: 1 - progress.value * 0.5 },
    ],
  }));
  return (
    <Animated.View
      testID="add-fly"
      pointerEvents="none"
      style={[styles.dot, style]}
    />
  );
});

type Props = {
  /** Bumps on every add; each bump launches one dot. */
  trigger: number;
  dx: number;
  dy: number;
};

/** Anchor this inside the `+` slot: it draws the fly dot on top of it. */
export const AddFeedback = memo(function AddFeedback({
  trigger,
  dx,
  dy,
}: Props) {
  const [flying, setFlying] = useState<number | null>(null);
  useEffect(() => {
    if (trigger > 0) setFlying(trigger);
  }, [trigger]);
  const done = useCallback(() => setFlying(null), []);
  return (
    <View pointerEvents="none" style={styles.anchor}>
      {flying !== null ? (
        <FlyDot key={flying} dx={dx} dy={dy} onDone={done} />
      ) : null}
    </View>
  );
});

type PopProps = { count: number; children: ReactNode };

/** Springs its child whenever `count` changes, so the cart pill answers an add. */
export const CartPop = memo(function CartPop({ count, children }: PopProps) {
  const scale = useSharedValue(1);
  const [previous, setPrevious] = useState(count);
  useEffect(() => {
    if (previous !== count) {
      setPrevious(count);
      scale.value = withSequence(
        withTiming(1.12, { duration: 120 }),
        withSpring(1, { damping: 10, stiffness: 300 }),
      );
    }
  }, [count, previous, scale]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
});

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
