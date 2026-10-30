import { memo, useState } from 'react';
import {
  KeyboardAvoidingView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { CheckButton, ScaledText, Sheet } from '@/components/ui';
import { usePatchStore, type BankAccount } from '@/lib/api';
import { useT } from '@/lib/i18n';
import {
  colors,
  fontFamily,
  radius,
  scaleText,
  space,
  useFontScale,
} from '@/theme';

import { strings } from './strings';
import { stripDiacritics } from './utils';

const BIN_RE = /^[0-9]{6}$/;
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
  const [name, setName] = useState(initial?.bank_short_name ?? '');
  const [bin, setBin] = useState(initial?.bank_bin ?? '');
  const [number, setNumber] = useState(initial?.account_number ?? '');
  const [holder, setHolder] = useState(initial?.account_name ?? '');
  const [errors, setErrors] = useState<Errors>({});

  const save = () => {
    const next: Errors = {};
    if (!BIN_RE.test(bin)) next.bin = t('bank.binError');
    if (!NUMBER_RE.test(number)) next.number = t('bank.numberError');
    if (!holder.trim()) next.holder = t('bank.holderError');
    setErrors(next);
    if (next.bin || next.number || next.holder) return;
    const shortName = name.trim();
    patch.mutate(
      {
        bank_account: {
          bank_bin: bin,
          account_number: number,
          account_name: holder.trim(),
          ...(shortName ? { bank_short_name: shortName } : {}),
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
      behavior="padding"
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
    >
      <Sheet onClose={onClose}>
        <ScaledText variant="heading" accessibilityRole="header">
          {t('bank.title')}
        </ScaledText>
        {field(t('bank.name'), name, setName)}
        {field(t('bank.bin'), bin, setBin, errors.bin, {
          keyboardType: 'number-pad',
          maxLength: 6,
        })}
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
