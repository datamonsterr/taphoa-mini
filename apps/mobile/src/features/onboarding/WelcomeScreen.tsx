import { useRouter } from 'expo-router';
import { Plus, QrCode } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { ScaledText } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space } from '@/theme';

import { useCurrentSessionSignOut } from '@/features/auth/useCurrentSessionSignOut';

import { ActionButton, Frame, FormError, Spacer } from './kit';
import { strings } from './strings';

/**
 * The scan card of board Welcome: a product framed on the dark camera surface with its price tag.
 * Drawn with views so it needs no asset.
 */
function Illustration() {
  return (
    <View style={styles.card} accessibilityElementsHidden>
      <View style={styles.ground} />
      <View style={styles.bottleCap} />
      <View style={styles.bottle}>
        <View style={styles.label} />
      </View>
      <View style={styles.frame} />
      <View style={styles.tag}>
        <ScaledText style={styles.tagText}>10.000</ScaledText>
      </View>
    </View>
  );
}

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
      fill
    >
      <Illustration />
      <Spacer />
      <ActionButton
        xl
        icon={Plus}
        testID="onboarding-create"
        label={t('welcome.create')}
        onPress={() => router.push('/create')}
      />
      <ActionButton
        xl
        icon={QrCode}
        variant="secondary"
        testID="onboarding-join"
        label={t('welcome.join')}
        onPress={() => router.push('/join')}
      />
      <FormError message={failed ? t('error.generic') : null} />
      <ActionButton
        variant="ghost"
        testID="onboarding-sign-out"
        label={t('welcome.signOut')}
        busy={busy}
        onPress={() => {
          void signOut();
        }}
      />
    </Frame>
  );
}

const styles = StyleSheet.create({
  card: {
    height: 300,
    borderRadius: radius.lg,
    backgroundColor: colors.cameraBg,
    overflow: 'hidden',
  },
  ground: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 200,
    height: 100,
    backgroundColor: '#38383e',
  },
  bottleCap: {
    position: 'absolute',
    alignSelf: 'center',
    top: 64,
    width: 25,
    height: 20,
    borderRadius: 5,
    backgroundColor: colors.ink,
  },
  bottle: {
    position: 'absolute',
    alignSelf: 'center',
    top: 80,
    width: 50,
    height: 150,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: {
    width: 50,
    height: 50,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  frame: {
    position: 'absolute',
    alignSelf: 'center',
    top: 48,
    width: 128,
    height: 196,
    borderWidth: 3,
    borderColor: colors.cameraInk,
    borderRadius: 20,
    backgroundColor: 'rgba(90,67,232,0.22)',
  },
  tag: {
    position: 'absolute',
    alignSelf: 'center',
    top: 222,
    height: 44,
    paddingHorizontal: space[4],
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 6,
  },
  tagText: {
    fontFamily: fontFamily.extrabold,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
});
