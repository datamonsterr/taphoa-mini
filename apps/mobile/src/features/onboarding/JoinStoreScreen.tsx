import { useState } from 'react';

import { joinStore } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { onboardingErrorKey, parseInviteToken } from './errors';
import { ActionButton, Field, FormError, Frame } from './kit';
import { strings } from './strings';

/** U1: the invite code from the Lead's phone plus the new member's name. Signing in leaves onboarding. */
export function JoinStoreScreen() {
  const t = useT(strings);
  const [token, setToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<{ token?: string; name?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const invite = parseInviteToken(token);
    const name = displayName.trim();
    const next = {
      ...(invite ? {} : { token: t('join.tokenError') }),
      ...(name && name.length <= 40
        ? {}
        : { name: t('join.displayNameError') }),
    };
    setErrors(next);
    setFailure(null);
    if (next.token || next.name) return;
    setBusy(true);
    try {
      await joinStore({ invite_token: invite, display_name: name });
    } catch (error) {
      setFailure(t(onboardingErrorKey(error)));
      setBusy(false);
    }
  };

  return (
    <Frame title={t('join.title')} subtitle={t('join.hint')}>
      <Field
        label={t('join.token')}
        value={token}
        onChangeText={setToken}
        error={errors.token}
        autoCapitalize="characters"
      />
      <Field
        label={t('join.displayName')}
        value={displayName}
        onChangeText={setDisplayName}
        error={errors.name}
        maxLength={40}
        autoCapitalize="words"
        onSubmitEditing={() => void submit()}
      />
      <FormError message={failure} />
      <ActionButton
        label={t('join.submit')}
        busy={busy}
        onPress={() => void submit()}
      />
    </Frame>
  );
}
