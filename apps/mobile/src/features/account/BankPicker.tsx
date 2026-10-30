import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { PressableScale, ScaledText } from '@/components/ui';
import { searchBanks, type Bank } from '@/lib/banks';
import {
  colors,
  fontFamily,
  radius,
  scaleText,
  space,
  useFontScale,
} from '@/theme';

const MAX_SUGGESTIONS = 6;

export type BankPickerProps = {
  label: string;
  placeholder: string;
  /** Shown when nothing matches the typed text. */
  emptyText: string;
  value: Bank | null;
  onChange: (bank: Bank | null) => void;
  error?: string;
  testID?: string;
};

/**
 * Pick the payee bank by name: type to filter the VietQR bank list, tap a row. The shop owner
 * never sees a BIN; the chosen bank carries its BIN and abbreviation.
 */
export function BankPicker({
  label,
  placeholder,
  emptyText,
  value,
  onChange,
  error,
  testID,
}: BankPickerProps) {
  const scale = useFontScale();
  const [query, setQuery] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const matches = searchBanks(query).slice(0, MAX_SUGGESTIONS);
  return (
    <View style={styles.field}>
      <ScaledText variant="caption" style={styles.label}>
        {label}
      </ScaledText>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={query}
        placeholder={placeholder}
        placeholderTextColor={colors.inkMuted}
        autoCorrect={false}
        onFocus={() => setOpen(true)}
        onChangeText={(text) => {
          setQuery(text);
          setOpen(true);
          if (value && text !== value.name) onChange(null);
        }}
        style={[
          styles.input,
          scaleText({ fontSize: 18 }, scale),
          error ? styles.invalid : null,
        ]}
      />
      {open && !value ? (
        <View style={styles.list} accessibilityRole="list">
          {matches.length ? (
            matches.map((bank) => (
              <PressableScale
                key={bank.bin}
                accessibilityRole="button"
                accessibilityLabel={bank.name}
                pressedScale={0.98}
                onPress={() => {
                  setQuery(bank.name);
                  setOpen(false);
                  onChange(bank);
                }}
                style={styles.row}
              >
                <ScaledText variant="label" style={styles.rowName}>
                  {bank.name}
                </ScaledText>
                <ScaledText variant="caption" style={styles.rowShort}>
                  {bank.short}
                </ScaledText>
              </PressableScale>
            ))
          ) : (
            <ScaledText variant="caption" style={styles.label}>
              {emptyText}
            </ScaledText>
          )}
        </View>
      ) : null}
      {error ? (
        <ScaledText variant="caption" style={styles.error}>
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
    minHeight: 56,
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
    color: colors.ink,
    fontFamily: fontFamily.semibold,
  },
  invalid: { borderWidth: 2, borderColor: colors.danger },
  list: {
    gap: space[1],
    padding: space[2],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[3],
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  rowName: { flex: 1, color: colors.ink },
  rowShort: { color: colors.inkMuted },
  error: { color: colors.danger },
});
