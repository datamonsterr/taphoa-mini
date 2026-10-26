import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { ScaledText } from '@/components/ui';
import {
  colors,
  radius,
  scaleText,
  size,
  space,
  typography,
  useFontScale,
} from '@/theme';

/** Style of a text field: body type scaled by the user's text size, at least 56 dp tall. */
export function useInputStyle() {
  const scale = useFontScale();
  return [styles.input, scaleText(typography.body, scale)];
}

type DebtInputProps = TextInputProps & { label: string; error?: string };

/** A labelled text field; the label is also its accessibility label. */
export function DebtInput({ label, error, style, ...rest }: DebtInputProps) {
  const inputStyle = useInputStyle();
  return (
    <View style={styles.field}>
      <ScaledText variant="caption" style={styles.label}>
        {label}
      </ScaledText>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.inkMuted}
        style={[inputStyle, error ? styles.invalid : null, style]}
        {...rest}
      />
      {error ? (
        <ScaledText
          variant="caption"
          accessibilityRole="alert"
          style={styles.error}
        >
          {error}
        </ScaledText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space[1] },
  label: { color: colors.inkMuted },
  input: {
    color: colors.ink,
    minHeight: size.tapMin,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space[4],
    backgroundColor: colors.surface,
  },
  invalid: { borderColor: colors.danger },
  error: { color: colors.danger },
});
