import { Banknote, QrCode, BookOpen } from 'lucide-react-native';
import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, radius } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type PayMethod = 'transfer' | 'cash' | 'credit';

export type PayToggleLabels = { group: string } & Record<
  Exclude<PayMethod, 'credit'>,
  string
> & { credit?: string };

const DEFAULT_LABELS: PayToggleLabels = {
  group: 'Cách trả',
  transfer: 'Chuyển khoản',
  cash: 'Tiền mặt',
  credit: 'Ghi nợ',
};

export type PayToggleProps = {
  value: PayMethod;
  onChange: (method: PayMethod) => void;
  /** Accessible names (the toggle shows icons only); Vietnamese by default. */
  labels?: PayToggleLabels;
};

const WIDTH = 56;
const HEIGHT = 48;
const GAP = 4;
const OPTIONS = [
  { id: 'transfer', icon: QrCode },
  { id: 'cash', icon: Banknote },
  { id: 'credit', icon: BookOpen },
] as const;

export const PayToggle = memo(function PayToggle({
  value,
  onChange,
  labels = DEFAULT_LABELS,
}: PayToggleProps) {
  const index = OPTIONS.findIndex((option) => option.id === value);
  const x = useSharedValue(index * (WIDTH + GAP));
  useEffect(() => {
    x.value = withTiming(index * (WIDTH + GAP), { duration: 160 });
  }, [index, x]);
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
  }));
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={labels.group}
      style={styles.track}
    >
      <Animated.View pointerEvents="none" style={[styles.thumb, thumb]} />
      {OPTIONS.map(({ id, icon }) => {
        const on = id === value;
        return (
          <PressableScale
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={labels[id] ?? DEFAULT_LABELS[id]}
            accessibilityState={{ checked: on, selected: on }}
            aria-checked={on}
            aria-selected={on}
            hitSlop={{ top: 4, bottom: 4 }}
            pressedScale={0.96}
            onPress={() => onChange(id)}
            style={styles.option}
          >
            <Icon icon={icon} color={on ? colors.onInk : colors.ink} />
          </PressableScale>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    gap: GAP,
    padding: 4,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  thumb: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: WIDTH,
    height: HEIGHT,
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  option: {
    width: WIDTH,
    height: HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
});
