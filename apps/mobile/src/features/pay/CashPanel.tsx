import { Undo2 } from '@/components/icons';
import { memo, useCallback } from 'react';
import { View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { formatVnd } from '@/lib/format';
import { colors } from '@/theme';

import { styles } from './payStyles';

type CashChipProps = {
  amount: number;
  pressed: boolean;
  onPick: (amount: number) => void;
};

const CashChip = memo(function CashChip({
  amount,
  pressed,
  onPick,
}: CashChipProps) {
  const pick = useCallback(() => onPick(amount), [onPick, amount]);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ selected: pressed }}
      aria-selected={pressed}
      onPress={pick}
      style={[styles.chip, pressed && styles.chipOn]}
    >
      <Text style={[styles.chipText, pressed && styles.chipTextOn]}>
        {formatVnd(amount).replace('đ', '')}
      </Text>
    </PressableScale>
  );
});

type Props = {
  options: number[];
  tendered: number | null;
  change: number;
  onPick: (amount: number) => void;
};

/** Cash card: quick notes and the change to hand back. */
export function CashPanel({ options, tendered, change, onPick }: Props) {
  return (
    <View style={styles.cashCard}>
      <View style={styles.chips}>
        {options.map((amount) => (
          <CashChip
            key={amount}
            amount={amount}
            pressed={amount === tendered}
            onPick={onPick}
          />
        ))}
      </View>
      <View style={styles.changeRow}>
        <Icon icon={Undo2} color={colors.inkMuted} />
        <Text accessibilityLabel="Tiền thối" style={styles.change}>
          {formatVnd(change)}
        </Text>
      </View>
    </View>
  );
}
