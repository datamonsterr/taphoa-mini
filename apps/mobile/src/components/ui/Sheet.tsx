import type { ReactNode } from 'react';
import { memo, useEffect } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, shadows, space } from '@/theme';

export const SHEET_PAN_TEST_ID = 'sheet-pan';
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
const TOP_GAP = 8;

/** A downward drag closes the sheet when far or fast enough. */
export function shouldDismiss(
  translationY: number,
  velocityY: number,
): boolean {
  return translationY > DISMISS_DISTANCE || velocityY > DISMISS_VELOCITY;
}

export type SheetProps = {
  children: ReactNode;
  onClose: () => void;
  /** Preferred sheet height, clamped to the window below the top inset; defaults to content height. */
  height?: number;
  /** Wrap content in a ScrollView (default). Pass false when the content scrolls itself. */
  scrollable?: boolean;
  /** Pinned under the scrolling content: stays inside the window whatever the content height. */
  footer?: ReactNode;
  testID?: string;
};

export const Sheet = memo(function Sheet({
  children,
  onClose,
  height,
  scrollable = true,
  footer,
  testID,
}: SheetProps) {
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const maxHeight = Math.max(0, screenHeight - insets.top - TOP_GAP);
  const fixedHeight =
    height === undefined ? undefined : Math.min(height, maxHeight);
  const translateY = useSharedValue(screenHeight);

  useEffect(() => {
    translateY.value = withTiming(0, { duration: 280 });
  }, [translateY]);

  const pan = usePanGesture({
    testID: SHEET_PAN_TEST_ID,
    runOnJS: true,
    activeOffsetY: 8,
    onUpdate: (event) => {
      translateY.value = Math.max(0, event.translationY);
    },
    onDeactivate: (event) => {
      if (shouldDismiss(event.translationY, event.velocityY)) {
        translateY.value = withTiming(screenHeight, { duration: 200 });
        onClose();
      } else {
        translateY.value = withSpring(0);
      }
    },
  });

  const animated = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View style={styles.root} testID={testID} pointerEvents="box-none">
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={onClose}
        style={styles.scrim}
        testID="sheet-scrim"
      />
      <Animated.View
        testID="sheet-panel"
        style={[
          styles.sheet,
          { paddingBottom: space[6] + insets.bottom, maxHeight },
          fixedHeight === undefined ? null : { height: fixedHeight },
          animated,
        ]}
      >
        <GestureDetector gesture={pan}>
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>
        {scrollable ? (
          <ScrollView
            testID="sheet-scroll"
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        ) : (
          children
        )}
        {footer === undefined ? null : (
          <View testID="sheet-footer">{footer}</View>
        )}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    paddingHorizontal: space[4],
    paddingTop: space[4],
    gap: space[3],
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
    ...shadows.sheet,
  },
  handleRow: { alignItems: 'center', paddingVertical: space[2] },
  scroll: { flexShrink: 1 },
  scrollContent: { flexGrow: 1, gap: space[3] },
  handle: {
    width: 40,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.surfacePressed,
  },
});
