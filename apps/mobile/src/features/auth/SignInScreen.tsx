import { useSessionList, useSignIn, useSignUp, useSSO } from '@clerk/expo';
import { onlineManager } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { Platform, StyleSheet, View } from 'react-native';
import { ScaledText } from '@/components/ui';
import { DeviceSessions } from '@/features/account/DeviceSessions';
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
import { signedInSessions } from './deviceSessions';
import { useEmailFlow } from './emailFlow';
import {
  authErrorKey,
  authFailureKey,
  clerkErrorCode,
  codeExpiry,
  codeWasSent,
} from './errors';
import { strings } from './strings';

WebBrowser.maybeCompleteAuthSession();

export function SignInScreen({ flow }: { flow?: AuthFlow }) {
  const t = useT(strings);
  const router = useRouter();
  const paths = flowPaths(flow);
  const cancelAdd = useCancelAddPerson();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { startSSOFlow } = useSSO();
  // After "Đăng xuất" nobody is active, but others may still be signed in on this phone. They
  // are picked here, behind their own PIN; adding a person while signed in has the account tab.
  const { sessions } = useSessionList();
  const people = flow === 'add' ? [] : signedInSessions(sessions);
  const switcher = useSwitchSession();
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const capturedSession = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('invalidEmail'));
      return;
    }
    if (!onlineManager.isOnline()) {
      setError(t('network'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      const result = await signIn.create({ identifier: address });
      let mode: 'signIn' | 'signUp' = 'signIn';
      let sendFailure: string | undefined;
      if (clerkErrorCode(result.error) === 'form_identifier_not_found') {
        mode = 'signUp';
        const created = await signUp.create({ emailAddress: address });
        if (created.error) throw created.error;
        const expiry = codeExpiry(signUp, 'signUp');
        const sent = await signUp.verifications.sendEmailCode();
        if (sent.error) throw sent.error;
        sendFailure =
          authFailureKey(sent, signUp, onlineManager.isOnline()) ??
          (codeWasSent(signUp, 'signUp', expiry) ? undefined : 'network');
      } else {
        if (result.error) throw result.error;
        // An offline phone makes `create` resolve quietly without starting the sign-in.
        if (signIn.status === 'needs_identifier')
          throw new TypeError('offline');
        const expiry = codeExpiry(signIn, 'signIn');
        const sent = await signIn.emailCode.sendCode({ emailAddress: address });
        if (sent.error) throw sent.error;
        sendFailure =
          authFailureKey(sent, signIn, onlineManager.isOnline()) ??
          (codeWasSent(signIn, 'signIn', expiry) ? undefined : 'network');
      }
      // Clerk does not always report a failed send in `sent.error` (an offline phone, a rate limit).
      if (sendFailure) {
        setError(t(sendFailure));
        return;
      }
      useEmailFlow.getState().begin(address, mode);
      router.push(paths.code);
    } catch (failure) {
      setError(t(authErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };
  const google = async () => {
    setBusy(true);
    setError(null);
    try {
      // This route also runs maybeCompleteAuthSession in the web popup callback.
      const result = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: makeRedirectUri({
          scheme: 'taphoa',
          path: paths.callback,
        }),
      });
      if (result.createdSessionId && result.setActive) {
        // Read before activating: the lock can flip while Clerk swaps sessions.
        const wasLocked = useDeviceLock.getState().locked;
        await result.setActive({
          session: result.createdSessionId,
          navigate: async () => {},
        });
        // Only a completed sign-in emits this event; session restoration never reaches here.
        if (capturedSession.current !== result.createdSessionId) {
          capturedSession.current = result.createdSessionId;
          capture('signed_in', { method: 'google' });
        }
        // A fresh sign-in proves who is holding the phone, so it lifts the device lock, after the
        // PIN if that person has one. Backing out of the PIN signs the new session out again.
        await switcher.admit(result.createdSessionId, wasLocked, (outcome) => {
          if (outcome === 'failed') setError(t('generic'));
        });
      } else if (
        result.authSessionResult?.type !== 'cancel' &&
        result.authSessionResult?.type !== 'dismiss'
      )
        setError(t('incomplete'));
    } catch (failure) {
      setError(t(authErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.fill}>
      <Frame
        testID="auth-sign-in-screen"
        title={t(flow === 'add' ? 'addTitle' : 'title')}
        back={false}
      >
        {people.length ? (
          <>
            <DeviceSessions
              variant="signIn"
              sessions={people}
              currentId={null}
              busy={switcher.busy}
              error={switcher.target ? null : switcher.error}
              onSwitch={switcher.begin}
            />
            <ScaledText variant="label" accessibilityRole="header">
              {t('otherEmail')}
            </ScaledText>
          </>
        ) : null}
        <Field
          testID="auth-email"
          label={t('email')}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          onSubmitEditing={() => {
            void submit();
          }}
        />
        {Platform.OS === 'web' ? (
          <View testID="auth-captcha" nativeID="clerk-captcha" />
        ) : null}
        <FormError message={error} />
        <ActionButton
          testID="auth-send-code"
          label={t('send')}
          busy={busy}
          onPress={() => {
            void submit();
          }}
        />
        <ActionButton
          testID="auth-google"
          label={t('google')}
          variant="secondary"
          disabled={busy}
          onPress={() => {
            void google();
          }}
        />
        {flow === 'add' ? (
          <ActionButton
            testID="auth-add-cancel"
            label={t('cancel')}
            variant="secondary"
            disabled={busy}
            onPress={() => {
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
