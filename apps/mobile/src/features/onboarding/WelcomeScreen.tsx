import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useT } from '@/lib/i18n';
import { space } from '@/theme';

import { ActionButton, Frame } from './kit';
import { strings } from './strings';

/** First screen without a session: create a store, join one by invite, or recover a Lead account. */
export function WelcomeScreen() {
  const t = useT(strings);
  const router = useRouter();
  return (
    <Frame
      title={t('welcome.title')}
      subtitle={t('welcome.subtitle')}
      back={false}
    >
      <View style={styles.actions}>
        <ActionButton
          label={t('welcome.create')}
          onPress={() => router.push('/create')}
        />
        <ActionButton
          variant="secondary"
          label={t('welcome.join')}
          onPress={() => router.push('/join')}
        />
        <ActionButton
          variant="secondary"
          label={t('welcome.recover')}
          onPress={() => router.push('/recover')}
        />
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space[3], marginTop: space[4] },
});
