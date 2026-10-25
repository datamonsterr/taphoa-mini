import { StyleSheet, View } from 'react-native';

import { PressableScale, Text } from '@/components/ui';
import { colors, radius, size, space, typography } from '@/theme';

export type Option<T extends string> = { value: T; label: string };

/** Two or three exclusive choices as pills (a radio group). */
export function Options<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={styles.row}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <PressableScale
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: on }}
            pressedScale={0.96}
            onPress={() => onChange(option.value)}
            style={[styles.pill, on && styles.pillOn]}
          >
            <Text style={[styles.text, on && styles.textOn]}>
              {option.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  pill: {
    flexGrow: 1,
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  pillOn: { backgroundColor: colors.ink },
  text: { ...typography.label, color: colors.ink },
  textOn: { color: colors.onInk },
});
