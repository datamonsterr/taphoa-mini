import { ChevronUp } from 'lucide-react-native';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { Icon } from '@/components/ui/Icon';
import { colors, radius, size } from '@/theme';

type Props = {
  onOpen: () => void;
};

const OPEN_DISTANCE = 40;
const OPEN_VELOCITY = 600;

/** Chevron and bar at the bottom: swipe up or tap opens the shop. */
export const SwipeHandle = memo(function SwipeHandle({ onOpen }: Props) {
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .withTestId('swipe-handle-pan')
      .runOnJS(true)
      .onEnd((event) => {
        if (
          event.translationY < -OPEN_DISTANCE ||
          event.velocityY < -OPEN_VELOCITY
        ) {
          onOpen();
        }
      });
    const tap = Gesture.Tap()
      .withTestId('swipe-handle-tap')
      .runOnJS(true)
      .onEnd(() => onOpen());
    return Gesture.Race(pan, tap);
  }, [onOpen]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel="Vuốt lên: cửa hàng"
        onAccessibilityTap={onOpen}
        style={styles.handle}
      >
        <Icon icon={ChevronUp} color={colors.cameraMuted} />
        <View style={styles.bar} />
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  handle: {
    width: 72,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  bar: {
    width: 36,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.cameraMuted,
  },
});
