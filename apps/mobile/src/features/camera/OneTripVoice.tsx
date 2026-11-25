import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Mic } from '@/components/icons';
import { Icon } from '@/components/ui/Icon';
import { useSettingsStore } from '@/stores/settings';
import { colors, fontSize, radius, size, space } from '@/theme';
import { fontFamily } from '@/theme/typography';

import { classifyFailure, uploadUtterance } from '../voice/api';
import type { VoiceClip } from '../voice/fixture';
import { useVoiceRecorder } from '../voice/useVoiceRecorder';
import { parseNamePrice } from './oneTrip';

/** Ends the clip after this much quiet: one short phrase, not a conversation. */
const SILENCE_MS = 1200;
const MAX_SECONDS = 8;

const HEARD_NOTHING = 'Chưa nghe rõ. Nói lại hoặc gõ tay.';
const FAILED = 'Chưa nghe được. Gõ tên và giá bằng tay nhé.';

type Props = {
  /** Dev and e2e builds: a fixture clip stands in for the microphone. */
  fixture?: string;
  onResult: (result: { name: string; price?: number }) => void;
};

/**
 * "Nói tên và giá": one utterance such as "mì hảo hảo năm nghìn" is transcribed on the server
 * (`mode=transcribe`) and split on the phone into name and price for the sheet. Hidden where the
 * phone cannot record (web without a fixture); typing always stays available.
 */
export function OneTripVoice({ fixture, onResult }: Props) {
  const language = useSettingsStore((s) => s.language);
  const elder = useSettingsStore((s) => s.elderMode);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef(0);

  const send = (clip: VoiceClip) => {
    const mine = ++attempt.current;
    setSending(true);
    uploadUtterance({
      clip,
      mode: 'transcribe',
      language,
      entry: 'chat',
      screen: 'enroll',
    }).then(
      (utterance) => {
        if (mine !== attempt.current) return;
        setSending(false);
        const parsed = parseNamePrice(utterance.transcript);
        if (parsed.name || parsed.price) onResult(parsed);
        else setError(HEARD_NOTHING);
      },
      (failure: unknown) => {
        if (mine !== attempt.current) return;
        setSending(false);
        setError(
          classifyFailure(failure) === 'no_speech' ? HEARD_NOTHING : FAILED,
        );
      },
    );
  };

  const recorder = useVoiceRecorder({
    fixture,
    silenceMs: SILENCE_MS,
    maxSeconds: MAX_SECONDS,
    onFinished: send,
  });
  if (!recorder.available) return null;
  const recording = recorder.status === 'recording';

  const onPress = async () => {
    if (recording) {
      void recorder.stop();
      return;
    }
    setError('');
    const started = await recorder.start();
    // A fixture has nothing to wait for.
    if (started && fixture) void recorder.stop();
    else if (!started && recorder.status === 'denied')
      setError('Chưa có quyền micro. Gõ tên và giá bằng tay nhé.');
  };

  const label = recording ? 'Xong' : 'Nói tên và giá';
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: sending }}
        disabled={sending}
        onPress={() => void onPress()}
        style={[
          styles.button,
          elder && styles.elderButton,
          recording && styles.recording,
        ]}
      >
        {sending ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Icon icon={Mic} color={colors.onAccent} />
        )}
        <Text style={[styles.text, elder && styles.elderText]}>
          {sending ? 'Đang nghe…' : recording ? 'Đang nghe… bấm Xong' : label}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[2] },
  button: {
    minHeight: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  elderButton: { minHeight: size.tapXl },
  recording: { backgroundColor: colors.ink },
  text: {
    color: colors.onAccent,
    fontFamily: fontFamily.semibold,
    fontSize: fontSize[18],
  },
  elderText: { fontSize: fontSize[24] },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.regular,
    fontSize: fontSize[16],
  },
});
