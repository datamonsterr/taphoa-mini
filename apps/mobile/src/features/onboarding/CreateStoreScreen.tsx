import { useRouter } from 'expo-router';
import { useState } from 'react';

import { createStore } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { onboardingErrorKey } from './errors';
import { ActionButton, Field, FormError, Frame } from './kit';
import { strings } from './strings';

/** F1: store name and the owner's name; the recovery code is shown on the next screen. */
export function CreateStoreScreen() {
  const t = useT(strings);
  const router = useRouter();
  const [storeName, setStoreName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<{ store?: string; name?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const store = storeName.trim();
    const name = displayName.trim();
    const next = {
      ...(store && store.length <= 80
        ? {}
        : { store: t('create.storeNameError') }),
      ...(name && name.length <= 40
        ? {}
        : { name: t('create.displayNameError') }),
    };
    setErrors(next);
    setFailure(null);
    if (next.store || next.name) return;
    setBusy(true);
    try {
      await createStore({ store_name: store, display_name: name });
      router.replace('/recovery-code');
    } catch (error) {
      setFailure(t(onboardingErrorKey(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title={t('create.title')}>
      <Field
        label={t('create.storeName')}
        value={storeName}
        onChangeText={setStoreName}
        error={errors.store}
        maxLength={80}
      />
      <Field
        label={t('create.displayName')}
        value={displayName}
        onChangeText={setDisplayName}
        error={errors.name}
        maxLength={40}
        autoCapitalize="words"
        onSubmitEditing={() => void submit()}
      />
      <FormError message={failure} />
      <ActionButton
        label={t('create.submit')}
        busy={busy}
        onPress={() => void submit()}
      />
    </Frame>
  );
}
