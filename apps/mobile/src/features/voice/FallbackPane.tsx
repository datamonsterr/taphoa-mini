import { memo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { useVoiceInput } from '../assistant/voice/useVoiceInput';
import { colors, space, typography } from '@/theme';

import { StatusPanel } from './StatusPanel';
import { voiceStrings } from './strings';
import { VoiceMicButton } from './VoiceMicButton';

export type FallbackPaneProps = {
  /** `server`: the upload failed. `device`: this device cannot record m4a (the web). */
  reason: 'server' | 'device';
  onAddToCart: (transcript: string) => void;
  onOpenCart: () => void;
  onClose: () => void;
};

/** On-device recognition: the seller speaks, the phone writes it, "Thêm vào giỏ" opens the catalog. */
export const FallbackPane = memo(function FallbackPane({
  reason,
  onAddToCart,
  onOpenCart,
  onClose,
}: FallbackPaneProps) {
  const t = useT(voiceStrings);
  const language = useSettingsStore((s) => s.language);
  const [transcript, setTranscript] = useState('');
  const voice = useVoiceInput({
    language,
    onPartial: setTranscript,
    onFinal: setTranscript,
  });
  const actions = [
    ...(transcript && !voice.listening
      ? [
          {
            label: t('addToCart'),
            onPress: () => onAddToCart(transcript),
            testID: 'voice-add-to-cart',
            primary: true,
          },
        ]
      : []),
    { label: t('openCart'), onPress: onOpenCart, testID: 'voice-open-cart' },
  ];
  return (
    <StatusPanel
      testID="voice-fallback"
      title={reason === 'server' ? t('fallbackTitle') : t('hint')}
      hint={
        !voice.available
          ? t('unavailable')
          : voice.error === 'permission'
            ? t('permissionHint')
            : reason === 'server'
              ? t('fallbackHint')
              : undefined
      }
      actions={actions}
      closeLabel={t('close')}
      onClose={onClose}
    >
      {voice.listening ? (
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {t('deviceListening')}
        </Text>
      ) : null}
      {transcript ? (
        <Text testID="voice-device-transcript" style={styles.transcript}>
          {`“${transcript}”`}
        </Text>
      ) : null}
      {voice.available ? (
        <View style={styles.mic}>
          <VoiceMicButton
            mode="hold"
            listening={voice.listening}
            label={t('retry')}
            onStart={() => void voice.start()}
            onStop={voice.stop}
            testID="voice-device-mic"
          />
        </View>
      ) : null}
    </StatusPanel>
  );
});

const styles = StyleSheet.create({
  status: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.inkMuted,
  },
  transcript: {
    ...typography.heading,
    textAlign: 'center',
    color: colors.ink,
  },
  mic: { alignItems: 'center', paddingTop: space[2] },
});
