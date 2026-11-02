import { memo, useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Text } from '@/components/ui';
import { strings } from '@/features/camera/strings';
import { useT } from '@/lib/i18n';
import { camera, colors, radius, space } from '@/theme';

export type CaptureMode = 'object' | 'code';

type Props = {
  mode: CaptureMode;
  onChange: (mode: CaptureMode) => void;
  disabled?: boolean;
};

const ITEM_WIDTH = 120;
const ITEM_HEIGHT = 48;

const options = [
  { mode: 'object', label: 'objectMode' },
  { mode: 'code', label: 'codeMode' },
] as const;

/** Camera input switch with a sliding white thumb. */
export const ModeToggle = memo(function ModeToggle({
  mode,
  onChange,
  disabled,
}: Props) {
  const t = useT(strings);
  const offset = useSharedValue(mode === 'code' ? 1 : 0);
  useEffect(() => {
    offset.value = withSpring(mode === 'code' ? 1 : 0, {
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
            accessibilityLabel={t(option.label)}
            accessibilityState={{ selected, disabled }}
            aria-selected={selected}
            hitSlop={{ top: 4, bottom: 4 }}
            disabled={disabled}
            onPress={() => onChange(option.mode)}
            style={styles.item}
          >
            <Text style={{ color: selected ? colors.ink : colors.cameraInk }}>
              {t(option.label)}
            </Text>
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
