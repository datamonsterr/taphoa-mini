import { Delete } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './ScaledText';

import { colors, radius, space, typography } from '@/theme';

import { Icon } from './Icon';
import { KEYPAD_LAYOUT } from './keypad';
import type { KeypadKeyId } from './keypad';
import { PressableScale } from './PressableScale';

export type KeypadLabels = { delete: string };

const DEFAULT_LABELS: KeypadLabels = { delete: 'Xóa' };

export type KeypadKeyProps = {
  keyId: KeypadKeyId;
  onPress: (key: KeypadKeyId) => void;
  /** Key diameter. Boards use 76 (enroll, expense) and 68 (close). */
  diameter?: number;
  disabled?: boolean;
  labels?: KeypadLabels;
};

export const KeypadKey = memo(function KeypadKey({
  keyId,
  onPress,
  diameter = 76,
  disabled = false,
  labels = DEFAULT_LABELS,
}: KeypadKeyProps) {
  const isDelete = keyId === 'delete';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={isDelete ? labels.delete : keyId}
      accessibilityState={{ disabled }}
      disabled={disabled}
      pressedScale={0.94}
      onPress={() => onPress(keyId)}
      style={[
        styles.key,
        { width: diameter, height: diameter },
        disabled && styles.disabled,
      ]}
    >
      {isDelete ? (
        <Icon icon={Delete} />
      ) : (
        <Text style={[styles.digit, keyId === '000' && styles.wide]}>
          {keyId}
        </Text>
      )}
    </PressableScale>
  );
});

export type KeypadProps = {
  onKey: (key: KeypadKeyId) => void;
  diameter?: number;
  disabled?: boolean;
  /** Accessible name of the delete key; Vietnamese by default. */
  labels?: KeypadLabels;
};

/** 3x4 pad: 1-9, 000, 0, delete. Pair with `applyKey`. */
export const Keypad = memo(function Keypad({
  onKey,
  diameter,
  disabled,
  labels,
}: KeypadProps) {
  return (
    <View style={styles.grid}>
      {KEYPAD_LAYOUT.map((keyId) => (
        <KeypadKey
          key={keyId}
          keyId={keyId}
          onPress={onKey}
          diameter={diameter}
          disabled={disabled}
          labels={labels}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: space[3],
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  disabled: { opacity: 0.4 },
  digit: {
    ...typography.heading,
    fontSize: 28,
    lineHeight: 34,
    color: colors.ink,
  },
  wide: { fontSize: 22, lineHeight: 28 },
});
