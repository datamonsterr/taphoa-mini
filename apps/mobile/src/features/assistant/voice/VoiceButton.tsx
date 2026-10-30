import * as Haptics from 'expo-haptics';
import { Mic } from 'lucide-react-native';
import { memo, useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Linking,
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

import { useVoiceServerChat } from '../flags';
import { recorderAvailable } from '../../voice/useVoiceRecorder';
import { voiceStrings } from './strings';
import { useServerVoiceInput } from './useServerVoiceInput';
import { useVoiceInput } from './useVoiceInput';

export type VoiceButtonProps = {
  language: Language;
  /** Running transcript while the button is held. */
  onPartial: (text: string) => void;
  /** Final transcript on release. The caller fills the input; nothing is sent. */
  onFinal: (text: string) => void;
  disabled?: boolean;
  /** True while a recorded clip is being transcribed on the server (the composer shows dots). */
  onPendingChange?: (pending: boolean) => void;
  /** True while the button is held and the engine is recording (the composer shows the meter). */
  onListeningChange?: (listening: boolean, tapToStop: boolean) => void;
};

const HINT_MS = 4000;
const HALO = 10;
/** After the server could not transcribe, the on-device recognizer takes over for this long. */
const FALLBACK_MS = 60_000;

/** What the button needs from an engine: the on-device recognizer or the server recording. */
type Engine = {
  available: boolean;
  listening: boolean;
  /** Recorded and waiting for the transcript. */
  transcribing?: boolean;
  /** Why the last hold produced nothing. `unavailable` is handled by the fallback notice. */
  error?: 'permission' | 'failed' | 'unavailable' | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
};

/**
 * Hold-to-talk microphone button (56 dp). The chat transcribes on the server (a recording sent
 * on release) while the `voice_server_chat` flag is on and the phone can record; offline, on a
 * server failure and on the web it uses the on-device recognizer. On Android and iOS it is
 * always there: without recognition it looks disabled and a press explains why. The web renders
 * nothing without it.
 */
export const VoiceButton = memo(function VoiceButton(props: VoiceButtonProps) {
  const serverChat = useVoiceServerChat() && recorderAvailable(undefined);
  const [fellBack, setFellBack] = useState(false);
  useEffect(() => {
    if (!fellBack) return undefined;
    const timer = setTimeout(() => setFellBack(false), FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [fellBack]);
  const onUnavailable = useCallback(() => setFellBack(true), []);
  if (serverChat && !fellBack)
    return <ServerVoiceButton {...props} onUnavailable={onUnavailable} />;
  const language = props.language;
  return (
    <DeviceVoiceButton
      {...props}
      notice={
        fellBack ? t(voiceStrings, 'serverFallback', language) : undefined
      }
    />
  );
});

const DeviceVoiceButton = memo(function DeviceVoiceButton({
  language,
  onPartial,
  onFinal,
  notice,
  ...rest
}: VoiceButtonProps & { notice?: string }) {
  const engine = useVoiceInput({ language, onPartial, onFinal });
  return (
    <VoiceButtonView
      language={language}
      engine={engine}
      notice={notice}
      {...rest}
    />
  );
});

const ServerVoiceButton = memo(function ServerVoiceButton({
  language,
  onFinal,
  onUnavailable,
  ...rest
}: VoiceButtonProps & { onUnavailable: () => void }) {
  const engine = useServerVoiceInput({ language, onFinal, onUnavailable });
  return <VoiceButtonView language={language} engine={engine} {...rest} />;
});

type ViewProps = {
  language: Language;
  engine: Engine;
  disabled?: boolean;
  /** A message above the button for a few seconds (for example the server fallback). */
  notice?: string;
  onPendingChange?: (pending: boolean) => void;
  onListeningChange?: (listening: boolean, tapToStop: boolean) => void;
};

function VoiceButtonView({
  language,
  engine,
  disabled = false,
  notice,
  onPendingChange,
  onListeningChange,
}: ViewProps) {
  const { available, listening, start, stop, cancel } = engine;
  const transcribing = engine.transcribing ?? false;
  useEffect(() => {
    onPendingChange?.(transcribing);
  }, [transcribing, onPendingChange]);

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

  useEffect(() => {
    onListeningChange?.(listening, screenReader);
  }, [listening, screenReader, onListeningChange]);

  const [noticeOpen, setNoticeOpen] = useState(Boolean(notice));
  useEffect(() => {
    if (!noticeOpen) return;
    const timer = setTimeout(() => setNoticeOpen(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [noticeOpen]);

  const errorKind =
    engine.error === 'permission' || engine.error === 'failed'
      ? engine.error
      : null;
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    // A failure fades after a while; the permission message stays until the next hold.
    if (errorKind !== 'failed') return undefined;
    const timer = setTimeout(() => setFaded(true), HINT_MS);
    return () => {
      clearTimeout(timer);
      setFaded(false);
    };
  }, [errorKind]);
  const errorOpen =
    errorKind === 'permission' || (errorKind === 'failed' && !faded);

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
          style={[styles.base, styles.unavailable, styles.disabled]}
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
    <View style={styles.anchor}>
      {listening ? (
        <View testID="voice-halo" pointerEvents="none" style={styles.halo} />
      ) : null}
      {errorOpen ? (
        <View
          testID={errorKind === 'permission' ? 'voice-denied' : 'voice-failed'}
          accessibilityLiveRegion="polite"
          style={styles.hint}
        >
          <Text style={styles.hintText}>
            {t(
              voiceStrings,
              errorKind === 'permission' ? 'micDenied' : 'failed',
              language,
            )}
          </Text>
          {errorKind === 'permission' ? (
            <PressableScale
              testID="voice-open-settings"
              accessibilityRole="button"
              accessibilityLabel={t(voiceStrings, 'openSettings', language)}
              onPress={() => void Linking.openSettings()}
              style={styles.hintAction}
            >
              <Text style={styles.hintActionText}>
                {t(voiceStrings, 'openSettings', language)}
              </Text>
            </PressableScale>
          ) : null}
        </View>
      ) : notice && noticeOpen ? (
        <View
          testID="voice-fallback-notice"
          accessibilityLiveRegion="polite"
          style={styles.hint}
        >
          <Text style={styles.hintText}>{notice}</Text>
        </View>
      ) : null}
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
          <Animated.View
            pointerEvents="none"
            style={[styles.ring, ringStyle]}
          />
        ) : null}
        <Icon icon={Mic} color={colors.onAccent} />
      </PressableScale>
    </View>
  );
}

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
  hintAction: {
    minHeight: size.tapMin,
    justifyContent: 'center',
    marginTop: space[1],
  },
  hintActionText: {
    ...typography.caption,
    color: colors.onInk,
    fontWeight: '700',
  },
  base: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  idle: { backgroundColor: colors.accent },
  listening: { backgroundColor: colors.accent },
  unavailable: { backgroundColor: colors.surfaceSoft },
  /** Board 17b: a soft accent halo 10 px outside the 56 dp button while it is held. */
  halo: {
    position: 'absolute',
    top: -HALO,
    right: -HALO,
    bottom: -HALO,
    left: -HALO,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    opacity: 0.18,
  },
  disabled: { opacity: 0.4 },
  ring: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
