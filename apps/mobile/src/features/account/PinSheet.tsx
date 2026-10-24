import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  CheckButton,
  Keypad,
  ScaledText,
  Sheet,
  type KeypadKeyId,
} from '@/components/ui';
import { useKeypadDiameter } from '@/components/ui/useKeypadDiameter';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, space } from '@/theme';

import { fill, strings } from './strings';

export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Appends a key's digits (a PIN may start with 0, so it is never a number) or drops the last. */
export function applyPinKey(pin: string, key: KeypadKeyId): string {
  if (key === 'delete') return pin.slice(0, -1);
  return (pin + key).slice(0, PIN_MAX);
}

export type PinSheetProps = {
  title: string;
  /** Accessible name of the confirm check button. */
  confirmLabel: string;
  /** Shown under the dots, e.g. "Mã PIN không đúng". */
  error?: string | null;
  busy?: boolean;
  onSubmit: (pin: string) => void;
  onClose: () => void;
};

/** Keypad sheet that collects a 4-6 digit PIN. The digits are never shown or spoken, only their count. */
export const PinSheet = memo(function PinSheet({
  title,
  confirmLabel,
  error,
  busy = false,
  onSubmit,
  onClose,
}: PinSheetProps) {
  const t = useT(strings);
  const diameter = useKeypadDiameter(68);
  const [pin, setPin] = useState('');
  const onKey = useCallback(
    (key: KeypadKeyId) => setPin((current) => applyPinKey(current, key)),
    [],
  );
  const ready = pin.length >= PIN_MIN && !busy;

  return (
    <Sheet onClose={onClose} scrollable={false}>
      <ScaledText
        variant="heading"
        accessibilityRole="header"
        style={styles.center}
      >
        {title}
      </ScaledText>
      <ScaledText
        accessibilityLabel={fill(t('pin.digits'), { n: pin.length })}
        variant="heading"
        style={styles.dots}
      >
        {pin.length ? '● '.repeat(pin.length).trim() : ' '}
      </ScaledText>
      <View style={styles.errorSlot}>
        {error ? (
          <ScaledText
            accessibilityRole="alert"
            variant="caption"
            style={styles.error}
          >
            {error}
          </ScaledText>
        ) : null}
      </View>
      <Keypad
        onKey={onKey}
        diameter={diameter}
        disabled={busy}
        labels={{ delete: t('pin.delete') }}
      />
      <CheckButton
        variant="ink"
        block
        accessibilityLabel={confirmLabel}
        disabled={!ready}
        onPress={() => onSubmit(pin)}
      />
    </Sheet>
  );
});

const styles = StyleSheet.create({
  center: { textAlign: 'center', color: colors.ink },
  dots: {
    textAlign: 'center',
    minHeight: 40,
    letterSpacing: 4,
    fontFamily: fontFamily.bold,
    color: colors.ink,
  },
  errorSlot: { minHeight: 24, alignItems: 'center', marginBottom: space[1] },
  error: { color: colors.danger, textAlign: 'center' },
});
