import { useSignIn, useSignUp } from '@clerk/expo';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import {
  Frame,
  Field,
  ActionButton,
  FormError,
} from '@/features/onboarding/kit';
import { useEmailFlow } from './emailFlow';
import { authErrorKey } from './errors';
import { strings } from './strings';

export function VerifyCodeScreen() {
  const t = useT(strings);
  const router = useRouter();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const mode = useEmailFlow((s) => s.mode);
  const email = useEmailFlow((s) => s.email);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!email) return <Redirect href="/sign-in" />;
  const verify = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t('invalidCode'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'signIn'
          ? await signIn.emailCode.verifyCode({ code })
          : await signUp.verifications.verifyEmailCode({ code });
      if (result.error) throw result.error;
      const resource = mode === 'signIn' ? signIn : signUp;
      if (resource.status !== 'complete') {
        setError(t('incomplete'));
        return;
      }
      const finalized = await resource.finalize({ navigate: async () => {} });
      if (finalized.error) throw finalized.error;
      useEmailFlow.getState().reset();
    } catch (failure) {
      setError(t(authErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'signIn'
          ? await signIn.emailCode.sendCode({ emailAddress: email })
          : await signUp.verifications.sendEmailCode();
      if (result.error) throw result.error;
    } catch (failure) {
      setError(t(authErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };
  const changeEmail = async () => {
    if (busy) return;
    await signIn.reset();
    await signUp.reset();
    useEmailFlow.getState().reset();
    router.replace('/sign-in');
  };
  return (
    <Frame testID="auth-code-screen" title={t('codeTitle')} subtitle={email}>
      <Field
        testID="auth-code"
        label={t('code')}
        value={code}
        onChangeText={setCode}
        maxLength={6}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        autoCapitalize="none"
        onSubmitEditing={() => {
          void verify();
        }}
      />
      <FormError message={error} />
      <ActionButton
        testID="auth-verify-code"
        label={t('verify')}
        busy={busy}
        onPress={() => {
          void verify();
        }}
      />
      <ActionButton
        testID="auth-resend-code"
        label={t('resend')}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          void resend();
        }}
      />
      <ActionButton
        testID="auth-change-email"
        label={t('changeEmail')}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          void changeEmail();
        }}
      />
    </Frame>
  );
}
