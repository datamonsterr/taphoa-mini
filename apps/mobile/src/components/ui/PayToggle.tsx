import { Banknote, BookText, QrCode } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './ScaledText';

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
  /** Visible words and accessible names; Vietnamese by default. */
  labels?: PayToggleLabels;
  /** Icons only (board 16); the labels stay as accessible names. */
  iconOnly?: boolean;
};

const GAP = 4;
const OPTIONS = [
  { id: 'transfer', icon: QrCode },
  { id: 'cash', icon: Banknote },
  { id: 'credit', icon: BookText },
] as const;

export const PayToggle = memo(function PayToggle({
  value,
  onChange,
  labels = DEFAULT_LABELS,
  iconOnly = false,
}: PayToggleProps) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={labels.group}
      style={styles.track}
    >
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
            pressedScale={0.96}
            onPress={() => onChange(id)}
            style={[styles.option, on && styles.selected]}
          >
            <Icon
              icon={icon}
              size={20}
              color={on ? colors.onInk : colors.ink}
            />
            {iconOnly ? null : (
              <Text
                numberOfLines={1}
                style={[styles.label, on && styles.labelOn]}
              >
                {labels[id] ?? DEFAULT_LABELS[id]}
              </Text>
            )}
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
  selected: { backgroundColor: colors.ink },
  label: {
    ...typography.caption,
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.ink,
  },
  labelOn: { color: colors.onInk },
  // Board 07: 14/18 label that never wraps. Each option is at least as wide as its words.
  option: {
    flexGrow: 1,
    flexShrink: 0,
    minWidth: size.tapMin,
    minHeight: size.tapMin,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: space[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
});
