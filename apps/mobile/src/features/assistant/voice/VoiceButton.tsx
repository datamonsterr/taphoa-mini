import * as Haptics from 'expo-haptics';
import { Mic } from 'lucide-react-native';
import { memo, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { t } from '@/lib/i18n';
import type { Language } from '@/stores/settings';
import { colors, radius, size, space, typography } from '@/theme';

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

const HINT_MS = 4000;

/**
 * Hold-to-talk microphone button (56 dp). On Android and iOS it is always there: without
 * recognition it looks disabled and a press explains why. The web renders nothing without it.
 */
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

  // A screen reader's double tap fires press-in and press-out together, so holding is
  // impossible: a tap toggles listening instead.
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

  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  if (!available) {
    if (Platform.OS === 'web') return null;
    const unavailable = t(voiceStrings, 'unavailable', language);
    return (
      <View style={styles.anchor}>
        {hint ? (
          <View
            testID="voice-unavailable"
            accessibilityLiveRegion="polite"
            style={styles.hint}
          >
            <Text style={styles.hintText}>{unavailable}</Text>
          </View>
        ) : null}
        <PressableScale
          testID="voice-button"
          accessibilityRole="button"
          accessibilityLabel={t(voiceStrings, 'hold', language)}
          accessibilityHint={unavailable}
          accessibilityState={{ disabled: true }}
          onPress={() => {
            setHint(true);
            AccessibilityInfo.announceForAccessibility(unavailable);
          }}
          style={[styles.base, styles.idle, styles.disabled]}
        >
          <Icon icon={Mic} color={colors.inkMuted} />
        </PressableScale>
      </View>
    );
  }

  const toggle = () => {
    if (listening) {
      stop();
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      void start();
    }
  };
  const holdProps = screenReader
    ? {
        onPress: toggle,
        accessibilityActions: [
          listening
            ? { name: 'stop', label: t(voiceStrings, 'stopAction', language) }
            : {
                name: 'start',
                label: t(voiceStrings, 'startAction', language),
              },
        ],
        onAccessibilityAction: (event: AccessibilityActionEvent) => {
          if (event.nativeEvent.actionName === 'stop') stop();
          else if (event.nativeEvent.actionName === 'start') void start();
        },
      }
    : {
        onPressIn: () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void start();
        },
        onPressOut: stop,
      };

  return (
    <PressableScale
      testID="voice-button"
      accessibilityRole="button"
      accessibilityLabel={t(
        voiceStrings,
        listening
          ? screenReader
            ? 'tapToStop'
            : 'listening'
          : screenReader
            ? 'tapToTalk'
            : 'hold',
        language,
      )}
      accessibilityState={{ disabled, busy: listening }}
      disabled={disabled}
      {...holdProps}
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
  anchor: { width: size.tapMin, height: size.tapMin },
  hint: {
    position: 'absolute',
    right: 0,
    bottom: size.tapMin + space[2],
    width: 220,
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.ink,
  },
  hintText: { ...typography.caption, color: colors.onInk },
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
