import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useT } from '@/lib/i18n';
import { space } from '@/theme';

import { useCurrentSessionSignOut } from '@/features/auth/useCurrentSessionSignOut';

import { ActionButton, Frame, FormError } from './kit';
import { strings } from './strings';

/** A Clerk user without memberships can create or join a store. */
export function WelcomeScreen() {
  const t = useT(strings);
  const router = useRouter();
  const { busy, failed, signOut } = useCurrentSessionSignOut();
  return (
    <Frame
      testID="onboarding-welcome-screen"
      title={t('welcome.title')}
      subtitle={t('welcome.subtitle')}
      back={false}
    >
      <View style={styles.actions}>
        <ActionButton
          testID="onboarding-create"
          label={t('welcome.create')}
          onPress={() => router.push('/create')}
        />
        <ActionButton
          variant="secondary"
          testID="onboarding-join"
          label={t('welcome.join')}
          onPress={() => router.push('/join')}
        />
        <ActionButton
          variant="secondary"
          testID="onboarding-sign-out"
          label={t('welcome.signOut')}
          busy={busy}
          onPress={() => {
            void signOut();
          }}
        />
        <FormError message={failed ? t('error.generic') : null} />
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space[3], marginTop: space[4] },
});
