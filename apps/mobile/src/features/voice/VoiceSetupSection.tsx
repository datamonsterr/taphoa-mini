import { Hand, LayoutGrid, Mic } from 'lucide-react-native';
import { memo, useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Icon, PressableScale, ScaledText, Switch } from '@/components/ui';
import { capture } from '@/lib/analytics';
import { useT } from '@/lib/i18n';
import { colors, radius, space } from '@/theme';

import { voiceBubble, voiceTile } from './quickAccess';
import { voiceStrings } from './strings';
import { useVoiceSettings } from './voiceSettings';

const BubbleRow = memo(function BubbleRow() {
  const t = useT(voiceStrings);
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void voiceBubble
      .isEnabled()
      .then((enabled) => alive && setOn(enabled))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const toggle = useCallback((next: boolean) => {
    setFailed(false);
    voiceBubble.setEnabled(next).then(
      (result) => {
        setOn(result);
        if (next && result)
          capture('voice_setup_completed', {
            platform: 'android',
            kind: 'bubble',
          });
        else if (next) setFailed(true);
      },
      () => setFailed(true),
    );
  }, []);
  return (
    <View testID="voice-bubble-row" style={[styles.row, styles.rowRight12]}>
      <Icon icon={Mic} color={colors.inkMuted} />
      <View style={styles.grow}>
        <ScaledText variant="label">{t('quick.bubble')}</ScaledText>
        {failed ? (
          <ScaledText
            variant="caption"
            accessibilityRole="alert"
            style={styles.error}
          >
            {t('quick.error')}
          </ScaledText>
        ) : null}
      </View>
      <Switch
        value={on}
        onValueChange={toggle}
        accessibilityLabel={t('quick.bubble')}
      />
    </View>
  );
});

const TileRow = memo(function TileRow() {
  const t = useT(voiceStrings);
  const [added, setAdded] = useState(false);
  const [failed, setFailed] = useState(false);
  const press = useCallback(() => {
    setFailed(false);
    voiceTile.requestAdd().then(
      (result) => {
        setAdded(result);
        if (result)
          capture('voice_setup_completed', {
            platform: 'android',
            kind: 'tile',
          });
        else setFailed(true);
      },
      () => setFailed(true),
    );
  }, []);
  return (
    <PressableScale
      testID="voice-tile-row"
      accessibilityRole="button"
      accessibilityLabel={t('quick.tile')}
      accessibilityState={{ disabled: added }}
      disabled={added}
      pressedScale={0.98}
      onPress={press}
      style={[styles.row, styles.rowRight16]}
    >
      <Icon icon={LayoutGrid} color={colors.inkMuted} />
      <View style={styles.grow}>
        <ScaledText variant="label">
          {added ? t('quick.tileAdded') : t('quick.tile')}
        </ScaledText>
        {failed ? (
          <ScaledText
            variant="caption"
            accessibilityRole="alert"
            style={styles.error}
          >
            {t('quick.error')}
          </ScaledText>
        ) : null}
      </View>
    </PressableScale>
  );
});

const DonateRow = memo(function DonateRow() {
  const t = useT(voiceStrings);
  const donate = useVoiceSettings((s) => s.donate);
  const setDonate = useVoiceSettings((s) => s.setDonate);
  return (
    <View testID="voice-donate-row" style={[styles.row, styles.rowRight12]}>
      <Icon icon={Hand} color={colors.inkMuted} />
      <View style={styles.grow}>
        <ScaledText variant="label">{t('donate')}</ScaledText>
        <ScaledText variant="caption" style={styles.hint}>
          {t('donate.hint')}
        </ScaledText>
      </View>
      <Switch
        value={donate}
        onValueChange={setDonate}
        accessibilityLabel={t('donate')}
      />
    </View>
  );
});

/**
 * The "Nút nói nhanh" part of the Account screen. The Android rows exist only where the native
 * module (V3) says it can do them; the opt-in switch is always there.
 */
export const VoiceSetupSection = memo(function VoiceSetupSection() {
  const t = useT(voiceStrings);
  const android = Platform.OS === 'android';
  const bubble = android && voiceBubble.isSupported();
  const tile = android && voiceTile.isSupported();
  return (
    <View testID="voice-setup" style={styles.section}>
      {bubble || tile ? (
        <ScaledText
          variant="label"
          accessibilityRole="header"
          style={styles.title}
        >
          {t('quick.title')}
        </ScaledText>
      ) : null}
      {bubble ? <BubbleRow /> : null}
      {tile ? <TileRow /> : null}
      <DonateRow />
    </View>
  );
});

const styles = StyleSheet.create({
  section: { gap: space[4] },
  title: { color: colors.inkMuted },
  grow: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 72,
    paddingLeft: space[4],
    paddingVertical: space[2],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  rowRight12: { paddingRight: space[3] },
  rowRight16: { paddingRight: space[4] },
  hint: { color: colors.inkMuted },
  error: { color: colors.danger },
});
