import { Focus, Grid2x2Plus } from 'lucide-react-native';
import { memo, useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import { camera, colors, radius, space } from '@/theme';

export type CaptureMode = 'one' | 'many';

type Props = {
  mode: CaptureMode;
  onChange: (mode: CaptureMode) => void;
};

const ITEM_WIDTH = 56;
const ITEM_HEIGHT = 48;

const options = [
  { mode: 'one', label: 'Một món', icon: Focus },
  { mode: 'many', label: 'Nhiều món', icon: Grid2x2Plus },
] as const;

/** One / many switch with a sliding white thumb. */
export const ModeToggle = memo(function ModeToggle({ mode, onChange }: Props) {
  const offset = useSharedValue(mode === 'many' ? 1 : 0);
  useEffect(() => {
    offset.value = withSpring(mode === 'many' ? 1 : 0, {
      damping: 18,
      stiffness: 220,
    });
  }, [mode, offset]);
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value * (ITEM_WIDTH + space[1]) }],
  }));

  return (
    <View style={styles.track}>
      <Animated.View
        testID="mode-thumb"
        style={[styles.thumb, thumbStyle]}
        pointerEvents="none"
      />
      {options.map((option) => {
        const selected = option.mode === mode;
        return (
          <Pressable
            key={option.mode}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            aria-selected={selected}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange(option.mode)}
            style={styles.item}
          >
            <Icon
              icon={option.icon}
              color={selected ? colors.ink : colors.cameraInk}
            />
          </Pressable>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    gap: space[1],
    padding: space[1],
    borderRadius: radius.full,
    backgroundColor: camera.glass,
  },
  thumb: {
    position: 'absolute',
    left: space[1],
    top: space[1],
    width: ITEM_WIDTH,
    height: ITEM_HEIGHT,
    borderRadius: radius.full,
    backgroundColor: camera.white,
  },
  item: {
    width: ITEM_WIDTH,
    height: ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
});
