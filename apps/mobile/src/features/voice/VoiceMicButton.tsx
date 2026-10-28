import * as Haptics from 'expo-haptics';
import { Mic, Square } from 'lucide-react-native';
import { memo, useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';

import { Icon, PressableScale } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, radius, size } from '@/theme';

import { voiceStrings } from './strings';

export type VoiceMicButtonProps = {
  /** `hold`: record while pressed (in the app). `toggle`: tap to start, tap to stop. */
  mode: 'hold' | 'toggle';
  listening: boolean;
  disabled?: boolean;
  /** Overrides the default "say more items" label. */
  label?: string;
  onStart: () => void;
  onStop: () => void;
  testID?: string;
};

/**
 * 56 dp microphone. A screen reader cannot hold a press, so with one on the button toggles
 * whatever the mode says.
 */
export const VoiceMicButton = memo(function VoiceMicButton({
  mode,
  listening,
  disabled = false,
  label,
  onStart,
  onStop,
  testID = 'voice-mic-button',
}: VoiceMicButtonProps) {
  const t = useT(voiceStrings);
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (alive) setScreenReader(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      setScreenReader,
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  const toggles = mode === 'toggle' || screenReader;
  const begin = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onStart();
  };
  const name =
    label ?? (listening ? t('micStop') : t(toggles ? 'tapMic' : 'holdMic'));
  const press = toggles
    ? { onPress: () => (listening ? onStop() : begin()) }
    : { onPressIn: begin, onPressOut: onStop };
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ disabled, busy: listening }}
      disabled={disabled}
      {...press}
      style={[styles.button, listening && styles.on, disabled && styles.off]}
    >
      <Icon
        icon={listening && toggles ? Square : Mic}
        color={listening ? colors.onAccent : colors.ink}
      />
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  button: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  on: { backgroundColor: colors.accent },
  off: { opacity: 0.4 },
});
