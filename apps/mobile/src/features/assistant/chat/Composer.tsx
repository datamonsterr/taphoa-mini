import { ArrowRight } from 'lucide-react-native';
import { memo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Text } from '@/components/ui/ScaledText';
import { PressableScale } from '@/components/ui/PressableScale';
import { t as translate, useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import {
  colors,
  radius,
  scaleText,
  size,
  space,
  typography,
  useFontScale,
} from '@/theme';

import { dict } from '../strings';
import { voiceStrings } from '../voice/strings';
import { VoiceButton } from '../voice/VoiceButton';
import { ListeningMeter } from './ListeningMeter';

export type ComposerProps = {
  streaming: boolean;
  /** Returns whether the turn was accepted; the text is kept when it was not. */
  onSend: (content: string, input: 'text' | 'voice') => boolean;
  /** Replaces the text whenever `id` changes (for example a tapped receipt line). */
  prefill?: { id: number; text: string };
};

const DOTS = '• • •';

const join = (a: string, b: string) => [a, b].filter(Boolean).join(' ');

/** Multiline input with Send and hold-to-talk. Voice only fills the input; it never sends. */
export const Composer = memo(function Composer({
  streaming,
  onSend,
  prefill,
}: ComposerProps) {
  const t = useT(dict);
  const language = useSettingsStore((s) => s.language);
  const scale = useFontScale();
  const [text, setText] = useState('');
  /** A recording is being transcribed on the server: the input shows three dots. */
  const [pending, setPending] = useState(false);
  /** The microphone is held: the input shows level bars and the timer (board 17b). */
  const [listening, setListening] = useState(false);
  const [seenPrefill, setSeenPrefill] = useState(prefill?.id);
  /** Text typed before the current hold; null between holds. */
  const heldBase = useRef<string | null>(null);
  /** The text last written by a voice transcript. */
  const voiceText = useRef<string | null>(null);

  if (prefill && prefill.id !== seenPrefill) {
    setSeenPrefill(prefill.id);
    setText(prefill.text);
  }

  const canSend = text.trim().length > 0 && !streaming;

  const send = () => {
    if (!canSend) return;
    if (
      onSend(text.trim(), voiceText.current === text ? 'voice' : 'text') ===
      false
    )
      return;
    voiceText.current = null;
    setText('');
  };

  const onPartial = (partial: string) => {
    heldBase.current ??= text;
    setText(join(heldBase.current, partial));
  };
  const onFinal = (final: string) => {
    const next = join(heldBase.current ?? text, final);
    heldBase.current = null;
    voiceText.current = next;
    setText(next);
  };

  return (
    <View style={styles.root}>
      {listening ? (
        <Text
          testID="assistant-listening-hint"
          accessibilityLiveRegion="polite"
          style={styles.hint}
        >
          {translate(voiceStrings, 'listening', language)}
        </Text>
      ) : null}
      <View style={styles.row}>
        {listening ? (
          <ListeningMeter
            label={translate(voiceStrings, 'listeningField', language)}
          />
        ) : null}
        <View style={[styles.field, listening && styles.hidden]}>
          <TextInput
            testID="assistant-input"
            accessibilityLabel={t('inputPlaceholder')}
            accessibilityHint={pending ? t('transcribing') : undefined}
            placeholder={pending ? DOTS : t('inputPlaceholder')}
            placeholderTextColor={colors.inkMuted}
            multiline
            // Enter sends and closes the keyboard.
            submitBehavior="blurAndSubmit"
            returnKeyType="send"
            onSubmitEditing={send}
            value={text}
            onChangeText={(next) => {
              heldBase.current = null;
              setText(next);
            }}
            style={[
              styles.input,
              scaleText({ fontSize: 17, lineHeight: 24 }, scale),
            ]}
          />
          {pending ? (
            <Text
              testID="assistant-transcribing"
              accessibilityRole="progressbar"
              accessibilityLabel={t('transcribing')}
              accessibilityLiveRegion="polite"
              style={styles.dots}
            >
              {DOTS}
            </Text>
          ) : null}
        </View>
        <VoiceButton
          language={language}
          onPartial={onPartial}
          onFinal={onFinal}
          disabled={streaming}
          onPendingChange={setPending}
          onListeningChange={setListening}
        />
        <PressableScale
          testID="assistant-send"
          accessibilityRole="button"
          accessibilityLabel={t('send')}
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={send}
          style={[styles.send, !canSend && styles.disabled]}
        >
          <Icon icon={ArrowRight} color={colors.onInk} />
        </PressableScale>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: space[3] },
  hint: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.inkMuted,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space[2] },
  field: { flex: 1, justifyContent: 'center' },
  /** Kept mounted (the typed text and the focus survive the hold) but out of sight. */
  hidden: { position: 'absolute', width: 0, height: 0, opacity: 0 },
  dots: {
    ...typography.body,
    position: 'absolute',
    right: space[4],
    color: colors.inkMuted,
  },
  input: {
    ...typography.body,
    minHeight: size.tapMin,
    maxHeight: 140,
    // 16, not the board's 20: Be Vietnam Pro 17 needs 192 dp for the placeholder, which a 20 dp
    // padding (186 dp) would wrap onto a second line.
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
    color: colors.ink,
  },
  send: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  disabled: { opacity: 0.4 },
});
