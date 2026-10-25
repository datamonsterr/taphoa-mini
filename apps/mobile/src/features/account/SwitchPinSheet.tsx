import { memo } from 'react';

import { useT } from '@/lib/i18n';

import { PinSheet } from './PinSheet';
import { fill, strings } from './strings';
import type { SwitchTarget } from './useSwitchSession';

export type SwitchPinSheetProps = {
  target: SwitchTarget;
  error: string | null;
  busy: boolean;
  /** Counts wrong entries so the digits clear after each one. */
  attempt: number;
  onSubmit: (pin: string) => void;
  onClose: () => void;
};

/** Asks for the PIN of the person being switched to. */
export const SwitchPinSheet = memo(function SwitchPinSheet({
  target,
  error,
  busy,
  attempt,
  onSubmit,
  onClose,
}: SwitchPinSheetProps) {
  const t = useT(strings);
  return (
    <PinSheet
      testID="account-switch-pin"
      title={fill(t('switch.pinTitle'), { name: target.name })}
      confirmLabel={t('pin.confirm')}
      error={error}
      busy={busy}
      clearKey={attempt}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
});
