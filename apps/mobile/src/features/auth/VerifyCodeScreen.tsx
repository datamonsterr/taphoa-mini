import { useSignIn, useSignUp } from '@clerk/expo';
import { onlineManager } from '@tanstack/react-query';
import { Redirect, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SwitchPinSheet } from '@/features/account/SwitchPinSheet';
import { useSwitchSession } from '@/features/account/useSwitchSession';
import { capture } from '@/lib/analytics';
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
import {
  authErrorKey,
  authFailureKey,
  codeExpiry,
  codeWasSent,
} from './errors';
import { strings } from './strings';

/**
 * Whether the code has not been accepted yet: a sign-in still waiting for its first factor, or a
 * sign-up whose email is not verified. Such a resource is a failed attempt, not an account that
 * needs another step.
 */
function codeNotAccepted(
  mode: 'signIn' | 'signUp',
  resource: { status?: unknown; verifications?: unknown },
): boolean {
  if (mode === 'signIn')
    return (
      resource.status === 'needs_first_factor' ||
      resource.status === 'needs_identifier'
    );
  const email = (
    resource.verifications as { emailAddress?: { status?: string } } | undefined
  )?.emailAddress;
  return !!email && email.status !== 'verified';
}

export function VerifyCodeScreen({ flow }: { flow?: AuthFlow }) {
  const t = useT(strings);
  const router = useRouter();
  const paths = flowPaths(flow);
  const cancelAdd = useCancelAddPerson();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  // A person with a PIN who signs in on a locked phone gives it before the lock lifts.
  const switcher = useSwitchSession();
  const mode = useEmailFlow((s) => s.mode);
  const email = useEmailFlow((s) => s.email);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const capturedSession = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cancelling clears the email; the pop animation must not bounce back to the form.
  const [leaving, setLeaving] = useState(false);
  if (!email && !leaving) return <Redirect href={paths.form} />;
  const restart = async () => {
    await signIn.reset();
    await signUp.reset();
    useEmailFlow.getState().reset();
    router.replace(paths.form);
  };
  const verify = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t('invalidCode'));
      return;
    }
    if (!onlineManager.isOnline()) {
      setError(t('network'));
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
        // Clerk does not always report a failed attempt in `result.error`: the resource's own
        // errors say why. A code that was neither accepted nor refused never reached Clerk (an
        // offline phone makes it resolve quietly), which is a network failure, not "needs support".
        const key =
          authFailureKey(result, resource, onlineManager.isOnline()) ??
          (codeNotAccepted(mode, resource) ? 'network' : 'incomplete');
        setError(t(key));
        return;
      }
      // Both are read before finalizing: the lock can flip while Clerk swaps sessions.
      const wasLocked = useDeviceLock.getState().locked;
      const sessionId = resource.createdSessionId;
      const finalized = await resource.finalize({ navigate: async () => {} });
      if (finalized.error) throw finalized.error;
      // Finalize activates the session. Repeated submissions for it must not double count.
      if (sessionId && capturedSession.current !== sessionId) {
        capturedSession.current = sessionId;
        capture('signed_in', { method: 'email_code' });
      }
      // A fresh sign-in proves who is holding the phone, so it lifts the device lock, after the
      // PIN if that person has one. Backing out of the PIN signs the new session out again.
      await switcher.admit(sessionId, wasLocked, (result) => {
        if (result === 'in') useEmailFlow.getState().reset();
        else if (result === 'cancelled') void restart();
        else setError(t('generic'));
      });
    } catch (failure) {
      setError(t(authErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    setError(null);
    if (!onlineManager.isOnline()) {
      setError(t('network'));
      return;
    }
    setBusy(true);
    try {
      const resource = mode === 'signIn' ? signIn : signUp;
      const expiryBefore = codeExpiry(resource, mode);
      const result =
        mode === 'signIn'
          ? await signIn.emailCode.sendCode({ emailAddress: email })
          : await signUp.verifications.sendEmailCode();
      if (result.error) throw result.error;
      const key =
        authFailureKey(result, resource, onlineManager.isOnline()) ??
        (codeWasSent(resource, mode, expiryBefore) ? undefined : 'network');
      if (key) setError(t(key));
    } catch (failure) {
      setError(t(authErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };
  const changeEmail = async () => {
    if (busy) return;
    await restart();
  };
  return (
    <View style={styles.fill}>
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
      {switcher.target ? (
        <SwitchPinSheet
          testID="auth-switch-pin"
          target={switcher.target}
          error={switcher.error}
          busy={switcher.busy}
          attempt={switcher.attempt}
          onSubmit={switcher.submitPin}
          onClose={switcher.cancel}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
