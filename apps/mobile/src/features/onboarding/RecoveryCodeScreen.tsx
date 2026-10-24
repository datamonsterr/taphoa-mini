import { Redirect } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { ScaledText } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session';
import { colors, fontFamily, radius, space } from '@/theme';

import { ActionButton, Frame } from './kit';
import { strings } from './strings';

/**
 * Shows the recovery code once. The session already exists; "Tiếp tục" confirms the code was
 * saved, which lets the root layout swap onboarding for the camera home.
 */
export function RecoveryCodeScreen() {
  const t = useT(strings);
  const code = useSessionStore((s) => s.pendingRecoveryCode);
  const acknowledge = useSessionStore((s) => s.acknowledgeRecoveryCode);

  if (!code) return <Redirect href="/welcome" />;

  return (
    <Frame title={t('code.title')} subtitle={t('code.hint')} back={false}>
      <View
        style={styles.card}
        accessible
        accessibilityLabel={`${t('code.value')}: ${code}`}
      >
        <ScaledText variant="heading" selectable style={styles.code}>
          {code}
        </ScaledText>
      </View>
      <ActionButton label={t('code.continue')} onPress={acknowledge} />
    </Frame>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    padding: space[6],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  code: {
    color: colors.ink,
    fontFamily: fontFamily.extrabold,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
    textAlign: 'center',
  },
});
