import { useSignIn, useSignUp } from '@clerk/expo';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { useDeviceLock } from '@/stores/deviceLock';
import {
  Frame,
  Field,
  ActionButton,
  FormError,
} from '@/features/onboarding/kit';
import { flowPaths, useCancelAddPerson, type AuthFlow } from './addPerson';
import { useEmailFlow } from './emailFlow';
import { authErrorKey } from './errors';
import { strings } from './strings';

export function VerifyCodeScreen({ flow }: { flow?: AuthFlow }) {
  const t = useT(strings);
  const router = useRouter();
  const paths = flowPaths(flow);
  const cancelAdd = useCancelAddPerson();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const mode = useEmailFlow((s) => s.mode);
  const email = useEmailFlow((s) => s.email);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancelling clears the email; the pop animation must not bounce back to the form.
  const [leaving, setLeaving] = useState(false);
  if (!email && !leaving) return <Redirect href={paths.form} />;
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
      // A fresh sign-in proves who is holding the phone, so it lifts the device lock.
      useDeviceLock.getState().unlock();
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
    router.replace(paths.form);
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
      {flow === 'add' ? (
        <ActionButton
          testID="auth-add-cancel"
          label={t('cancel')}
          variant="secondary"
          disabled={busy}
          onPress={() => {
            setLeaving(true);
            void cancelAdd();
          }}
        />
      ) : null}
    </Frame>
  );
}
