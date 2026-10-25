import { useInviteIntent } from './inviteIntent';
import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useCompleteOnboarding } from './useCompleteOnboarding';

import { joinStore, useMe } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { onboardingErrorKey, parseInviteToken } from './errors';
import { ActionButton, Field, FormError, Frame } from './kit';
import { strings } from './strings';

/** U1: the invite code from the Lead's phone plus the new member's name. Signing in leaves onboarding. */
export function JoinStoreScreen() {
  const t = useT(strings);
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const complete = useCompleteOnboarding();
  const me = useMe();
  const [token, setToken] = useState(
    typeof params.token === 'string'
      ? params.token
      : (params.token?.[0] ?? useInviteIntent.getState().token),
  );
  const [nameDraft, setDisplayName] = useState<string>();
  const displayName = nameDraft ?? me.data?.profile?.display_name ?? '';
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
      const membership = await joinStore({
        invite_token: invite,
        display_name: name,
      });
      complete(membership);
    } catch (error) {
      setFailure(t(onboardingErrorKey(error)));
      setBusy(false);
    }
  };

  return (
    <Frame
      testID="join-store-screen"
      title={t('join.title')}
      subtitle={t('join.hint')}
    >
      <Field
        testID="join-invite-token"
        label={t('join.token')}
        value={token}
        onChangeText={setToken}
        error={errors.token}
        autoCapitalize="characters"
      />
      <Field
        testID="join-display-name"
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
        testID="join-store-submit"
        label={t('join.submit')}
        busy={busy}
        onPress={() => void submit()}
      />
    </Frame>
  );
}
