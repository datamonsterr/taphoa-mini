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
  /** Digits 0-9 and delete only (a PIN pad): the "000" slot stays empty. */
  digitsOnly?: boolean;
};

const ROWS = [0, 1, 2, 3].map((row) =>
  KEYPAD_LAYOUT.slice(row * 3, row * 3 + 3),
);

/** 3x4 pad: 1-9, 000, 0, delete. Pair with `applyKey`. */
export const Keypad = memo(function Keypad({
  onKey,
  diameter,
  disabled,
  labels,
  digitsOnly = false,
}: KeypadProps) {
  // Board: a 3-column grid, each key centred in its third (1-9, 000, 0, delete).
  return (
    <View testID="keypad" style={styles.grid}>
      {ROWS.map((row) => (
        <View key={row[0]} style={styles.row}>
          {row.map((keyId) => (
            <View key={keyId} style={styles.cell}>
              {digitsOnly && keyId === '000' ? null : (
                <KeypadKey
                  keyId={keyId}
                  onPress={onKey}
                  diameter={diameter}
                  disabled={disabled}
                  labels={labels}
                />
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  grid: { rowGap: space[3] },
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center' },
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
