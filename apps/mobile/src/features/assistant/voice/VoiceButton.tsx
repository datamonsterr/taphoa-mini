import * as Haptics from 'expo-haptics';
import { Mic } from 'lucide-react-native';
import { memo, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { t } from '@/lib/i18n';
import type { Language } from '@/stores/settings';
import { colors, radius, size } from '@/theme';

import { voiceStrings } from './strings';
import { useVoiceInput } from './useVoiceInput';

export type VoiceButtonProps = {
  language: Language;
  /** Running transcript while the button is held. */
  onPartial: (text: string) => void;
  /** Final transcript on release. The caller fills the input; nothing is sent. */
  onFinal: (text: string) => void;
  disabled?: boolean;
};

/** Hold-to-talk microphone button (56 dp). Renders nothing when recognition is unavailable. */
export const VoiceButton = memo(function VoiceButton({
  language,
  onPartial,
  onFinal,
  disabled = false,
}: VoiceButtonProps) {
  const { available, listening, start, stop, cancel } = useVoiceInput({
    language,
    onPartial,
    onFinal,
  });

  const pulse = useSharedValue(0);
  useEffect(() => {
    if (listening) {
      pulse.value = withRepeat(withTiming(1, { duration: 900 }), -1, false);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
  }, [listening, pulse]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - pulse.value),
    transform: [{ scale: 1 + 0.5 * pulse.value }],
  }));

  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  if (!available) return null;

  return (
    <PressableScale
      testID="voice-button"
      accessibilityRole="button"
      accessibilityLabel={t(
        voiceStrings,
        listening ? 'listening' : 'hold',
        language,
      )}
      accessibilityState={{ disabled, busy: listening }}
      disabled={disabled}
      onPressIn={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        void start();
      }}
      onPressOut={stop}
      style={[
        styles.base,
        listening ? styles.listening : styles.idle,
        disabled && styles.disabled,
      ]}
    >
      {listening ? (
        <Animated.View pointerEvents="none" style={[styles.ring, ringStyle]} />
      ) : null}
      <Icon icon={Mic} color={listening ? colors.onAccent : colors.ink} />
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  base: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  idle: { backgroundColor: colors.surfaceSoft },
  listening: { backgroundColor: colors.accent },
  disabled: { opacity: 0.4 },
  ring: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
