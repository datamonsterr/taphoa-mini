import { memo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { CheckButton, ScaledText, Sheet } from '@/components/ui';
import { usePatchStore, type BankAccount } from '@/lib/api';
import { bankByBin, type Bank } from '@/lib/banks';
import { useT } from '@/lib/i18n';
import {
  colors,
  fontFamily,
  radius,
  scaleText,
  space,
  useFontScale,
} from '@/theme';

import { BankPicker } from './BankPicker';
import { strings } from './strings';
import { stripDiacritics } from './utils';

const NUMBER_RE = /^[0-9A-Za-z]{4,19}$/;

export type BankSheetProps = {
  initial: BankAccount | null | undefined;
  onClose: () => void;
};

type Errors = { bin?: string; number?: string; holder?: string };

/** Edit form for the VietQR payee; saves with `PATCH /v1/store`. */
export const BankSheet = memo(function BankSheet({
  initial,
  onClose,
}: BankSheetProps) {
  const t = useT(strings);
  const scale = useFontScale();
  const patch = usePatchStore();
  // A saved account whose bank is not in the list keeps its BIN and short name as typed before.
  const [bank, setBank] = useState<Bank | null>(
    initial
      ? (bankByBin(initial.bank_bin) ?? {
          bin: initial.bank_bin,
          short: initial.bank_short_name ?? initial.bank_bin,
          name: initial.bank_short_name ?? initial.bank_bin,
        })
      : null,
  );
  const [number, setNumber] = useState(initial?.account_number ?? '');
  const [holder, setHolder] = useState(initial?.account_name ?? '');
  const [errors, setErrors] = useState<Errors>({});

  const save = () => {
    const next: Errors = {};
    if (!bank) next.bin = t('bank.binError');
    if (!NUMBER_RE.test(number)) next.number = t('bank.numberError');
    if (!holder.trim()) next.holder = t('bank.holderError');
    setErrors(next);
    if (!bank || next.number || next.holder) return;
    patch.mutate(
      {
        bank_account: {
          bank_bin: bank.bin,
          bank_short_name: bank.short,
          account_number: number,
          account_name: holder.trim(),
        },
      },
      { onSuccess: onClose },
    );
  };

  const inputStyle = [styles.input, scaleText({ fontSize: 18 }, scale)];
  const field = (
    label: string,
    value: string,
    onChange: (text: string) => void,
    error?: string,
    extra: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) => (
    <View style={styles.field}>
      <ScaledText variant="caption" style={styles.label}>
        {label}
      </ScaledText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        style={[inputStyle, error ? styles.invalid : null]}
        placeholderTextColor={colors.inkMuted}
        {...extra}
      />
      {error ? (
        <ScaledText variant="caption" style={styles.error}>
          {error}
        </ScaledText>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
    >
      <Sheet onClose={onClose}>
        <ScaledText variant="heading" accessibilityRole="header">
          {t('bank.title')}
        </ScaledText>
        <BankPicker
          label={t('bank.name')}
          placeholder={t('bank.pick')}
          emptyText={t('bank.none')}
          value={bank}
          onChange={setBank}
          error={errors.bin}
        />
        {field(t('bank.number'), number, setNumber, errors.number, {
          maxLength: 19,
          autoCapitalize: 'characters',
        })}
        {field(
          t('bank.holder'),
          holder,
          (text) => setHolder(stripDiacritics(text)),
          errors.holder,
          { maxLength: 50, autoCapitalize: 'characters' },
        )}
        {patch.isError ? (
          <ScaledText variant="caption" style={styles.error}>
            {t('bank.saveError')}
          </ScaledText>
        ) : null}
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('bank.save')}
          disabled={patch.isPending}
          onPress={save}
        />
      </Sheet>
    </KeyboardAvoidingView>
  );
});

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
  error: { color: colors.danger },
});
