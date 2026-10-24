import { memo, useState } from 'react';

import { useSetPin } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { PinSheet } from './PinSheet';
import { strings } from './strings';

export type SetPinSheetProps = { onClose: () => void; onSaved: () => void };

/** Two steps: the new PIN, then the same PIN again. Saves with `PUT /v1/me/pin`. */
export const SetPinSheet = memo(function SetPinSheet({
  onClose,
  onSaved,
}: SetPinSheetProps) {
  const t = useT(strings);
  const setPin = useSetPin();
  const [first, setFirst] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);

  if (first === null) {
    return (
      <PinSheet
        key="new"
        title={t('pin.newTitle')}
        confirmLabel={t('pin.next')}
        error={mismatch ? t('pin.mismatch') : null}
        onSubmit={(pin) => {
          setMismatch(false);
          setFirst(pin);
        }}
        onClose={onClose}
      />
    );
  }
  return (
    <PinSheet
      key="again"
      title={t('pin.againTitle')}
      confirmLabel={t('pin.confirm')}
      busy={setPin.isPending}
      error={setPin.isError ? t('pin.saveError') : null}
      onSubmit={(pin) => {
        if (pin !== first) {
          setPin.reset();
          setMismatch(true);
          setFirst(null);
          return;
        }
        setPin.mutate(pin, { onSuccess: onSaved });
      }}
      onClose={onClose}
    />
  );
});
