import { ArrowUp } from 'lucide-react-native';
import { memo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { useT } from '@/lib/i18n';
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
import { VoiceButton } from '../voice/VoiceButton';

export type ComposerProps = {
  streaming: boolean;
  /** Returns whether the turn was accepted; the text is kept when it was not. */
  onSend: (content: string, input: 'text' | 'voice') => boolean;
  /** Replaces the text whenever `id` changes (for example a tapped receipt line). */
  prefill?: { id: number; text: string };
};

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
    <View style={styles.row}>
      <TextInput
        testID="assistant-input"
        accessibilityLabel={t('inputPlaceholder')}
        placeholder={t('inputPlaceholder')}
        placeholderTextColor={colors.inkMuted}
        multiline
        // Enter sends and closes the keyboard (the sheet does not lift the composer above it).
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
          scaleText({ fontSize: 18, lineHeight: 24 }, scale),
        ]}
      />
      <VoiceButton
        language={language}
        onPartial={onPartial}
        onFinal={onFinal}
        disabled={streaming}
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
        <Icon icon={ArrowUp} color={colors.onAccent} />
      </PressableScale>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space[2] },
  input: {
    ...typography.body,
    flex: 1,
    minHeight: size.tapMin,
    maxHeight: 140,
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
    backgroundColor: colors.accent,
  },
  disabled: { opacity: 0.4 },
});
