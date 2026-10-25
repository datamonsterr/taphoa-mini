import { useState } from 'react';

import { createStore, useMe } from '@/lib/api';
import { stripDiacritics } from '@/features/account/utils';
import { useCompleteOnboarding } from './useCompleteOnboarding';
import { useT } from '@/lib/i18n';

import { onboardingErrorKey } from './errors';
import { ActionButton, Field, FormError, Frame } from './kit';
import { strings } from './strings';

/** Creates a Clerk user's first store and selects its Lead membership. */
export function CreateStoreScreen() {
  const t = useT(strings);
  const me = useMe();
  const complete = useCompleteOnboarding();
  const [storeName, setStoreName] = useState('');
  const [nameDraft, setDisplayName] = useState<string>();
  const displayName = nameDraft ?? me.data?.profile?.display_name ?? '';
  const [bankBin, setBankBin] = useState('');
  const [bankNumber, setBankNumber] = useState('');
  const [bankHolder, setBankHolder] = useState('');
  const [errors, setErrors] = useState<{
    store?: string;
    name?: string;
    bank?: string;
  }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const store = storeName.trim();
    const name = displayName.trim();
    const hasBank = !!(bankBin || bankNumber || bankHolder);
    const bankValid =
      /^\d{6}$/.test(bankBin) &&
      /^[0-9A-Za-z]{4,19}$/.test(bankNumber) &&
      !!bankHolder.trim();
    const next = {
      ...(hasBank && !bankValid ? { bank: t('create.bankError') } : {}),
      ...(store && store.length <= 80
        ? {}
        : { store: t('create.storeNameError') }),
      ...(name && name.length <= 40
        ? {}
        : { name: t('create.displayNameError') }),
    };
    setErrors(next);
    setFailure(null);
    if (next.store || next.name || next.bank) return;
    setBusy(true);
    try {
      const membership = await createStore({
        store_name: store,
        display_name: name,
        ...(hasBank
          ? {
              bank_account: {
                bank_bin: bankBin,
                account_number: bankNumber,
                account_name: stripDiacritics(bankHolder.trim()),
              },
            }
          : {}),
      });
      complete(membership);
    } catch (error) {
      setFailure(t(onboardingErrorKey(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame testID="create-store-screen" title={t('create.title')}>
      <Field
        testID="create-store-name"
        label={t('create.storeName')}
        value={storeName}
        onChangeText={setStoreName}
        error={errors.store}
        maxLength={80}
      />
      <Field
        testID="create-display-name"
        label={t('create.displayName')}
        value={displayName}
        onChangeText={setDisplayName}
        error={errors.name}
        maxLength={40}
        autoCapitalize="words"
        onSubmitEditing={() => void submit()}
      />
      <Field
        testID="create-bank-bin"
        label={t('create.bankBin')}
        value={bankBin}
        onChangeText={setBankBin}
        maxLength={6}
        keyboardType="number-pad"
      />
      <Field
        testID="create-bank-number"
        label={t('create.bankNumber')}
        value={bankNumber}
        onChangeText={setBankNumber}
        maxLength={19}
        autoCapitalize="none"
      />
      <Field
        testID="create-bank-holder"
        label={t('create.bankHolder')}
        value={bankHolder}
        onChangeText={setBankHolder}
        maxLength={80}
        autoCapitalize="characters"
      />
      <FormError message={errors.bank ?? failure} />
      <ActionButton
        testID="create-store-submit"
        label={t('create.submit')}
        busy={busy}
        onPress={() => void submit()}
      />
    </Frame>
  );
}
