import { useSessionList, useSignIn, useSignUp, useSSO } from '@clerk/expo';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { Platform, StyleSheet, View } from 'react-native';
import { ScaledText } from '@/components/ui';
import { DeviceSessions } from '@/features/account/DeviceSessions';
import { SwitchPinSheet } from '@/features/account/SwitchPinSheet';
import { useSwitchSession } from '@/features/account/useSwitchSession';
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
import { authErrorKey, clerkErrorCode } from './errors';
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
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('invalidEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      const result = await signIn.create({ identifier: address });
      let mode: 'signIn' | 'signUp' = 'signIn';
      if (clerkErrorCode(result.error) === 'form_identifier_not_found') {
        mode = 'signUp';
        const created = await signUp.create({ emailAddress: address });
        if (created.error) throw created.error;
        const sent = await signUp.verifications.sendEmailCode();
        if (sent.error) throw sent.error;
      } else {
        if (result.error) throw result.error;
        const sent = await signIn.emailCode.sendCode({ emailAddress: address });
        if (sent.error) throw sent.error;
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
        await result.setActive({
          session: result.createdSessionId,
          navigate: async () => {},
        });
        // A fresh sign-in proves who is holding the phone, so it lifts the device lock.
        useDeviceLock.getState().unlock();
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
