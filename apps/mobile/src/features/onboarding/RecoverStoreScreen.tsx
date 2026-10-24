import { useRouter } from 'expo-router';
import { useState } from 'react';

import { recoverStore } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { onboardingErrorKey } from './errors';
import { ActionButton, Field, FormError, Frame } from './kit';
import { strings } from './strings';

/** Lead on a new phone: the saved recovery code signs in and the server answers with a fresh one. */
export function RecoverStoreScreen() {
  const t = useT(strings);
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = code.trim();
    setError(trimmed ? undefined : t('recover.codeError'));
    setFailure(null);
    if (!trimmed) return;
    setBusy(true);
    try {
      await recoverStore({ recovery_code: trimmed });
      router.replace('/recovery-code');
    } catch (cause) {
      setFailure(t(onboardingErrorKey(cause, 'error.recover')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title={t('recover.title')} subtitle={t('recover.hint')}>
      <Field
        label={t('recover.code')}
        value={code}
        onChangeText={setCode}
        error={error}
        autoCapitalize="characters"
        onSubmitEditing={() => void submit()}
      />
      <FormError message={failure} />
      <ActionButton
        label={t('recover.submit')}
        busy={busy}
        onPress={() => void submit()}
      />
    </Frame>
  );
}
