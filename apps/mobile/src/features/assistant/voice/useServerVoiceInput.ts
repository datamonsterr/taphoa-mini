import { useCallback, useEffect, useRef, useState } from 'react';

import { capture } from '@/lib/analytics';
import type { Language } from '@/stores/settings';

import { classifyFailure, uploadUtterance } from '../../voice/api';
import type { VoiceClip } from '../../voice/fixture';
import {
  recorderAvailable,
  useVoiceRecorder,
} from '../../voice/useVoiceRecorder';
import { voiceLocale } from './useVoiceInput';

/** `unavailable`: offline or the server cannot transcribe; the caller falls back to the device. */
export type ServerVoiceError = 'permission' | 'failed' | 'unavailable';

export type UseServerVoiceInputOptions = {
  language: Language;
  /** Called once per hold with the transcript, only when it is not empty. */
  onFinal: (text: string) => void;
  /** The upload failed in a way the on-device recognizer can replace (offline, 503). */
  onUnavailable?: () => void;
};

export type ServerVoiceInput = {
  available: boolean;
  /** Recording (the button is held). */
  listening: boolean;
  /** The clip is uploaded and the transcript has not come back yet. */
  transcribing: boolean;
  error: ServerVoiceError | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
};

/**
 * Hold-to-talk through the server: records with expo-audio, uploads with `mode=transcribe` on
 * release. Never sends anything itself; the transcript only fills the composer.
 */
export function useServerVoiceInput({
  language,
  onFinal,
  onUnavailable,
}: UseServerVoiceInputOptions): ServerVoiceInput {
  const [transcribing, setTranscribing] = useState(false);
  const [failure, setFailure] = useState<'failed' | 'unavailable' | null>(null);

  const callbacks = useRef({ onFinal, onUnavailable });
  useEffect(() => {
    callbacks.current = { onFinal, onUnavailable };
  });
  /** Bumped on cancel and unmount: a late answer is dropped. */
  const attempt = useRef(0);
  /** True from the press until the release; a quick release beats the permission prompt. */
  const holding = useRef(false);

  const upload = useCallback(
    (clip: VoiceClip) => {
      const mine = ++attempt.current;
      const locale = voiceLocale(language);
      setTranscribing(true);
      uploadUtterance({
        clip,
        mode: 'transcribe',
        language,
        entry: 'chat',
        screen: 'assistant',
      }).then(
        (utterance) => {
          if (mine !== attempt.current) return;
          setTranscribing(false);
          const text = utterance.transcript.trim();
          capture('voice_input_used', {
            duration_ms: clip.durationMs,
            language: locale,
            ok: text !== '',
            engine: 'server',
          });
          if (text) callbacks.current.onFinal(text);
        },
        (error: unknown) => {
          if (mine !== attempt.current) return;
          setTranscribing(false);
          const kind = classifyFailure(error);
          capture('voice_input_used', {
            duration_ms: clip.durationMs,
            language: locale,
            ok: false,
            engine: 'server',
          });
          // Nothing heard is not an error for the seller.
          if (kind === 'no_speech') return;
          if (kind === 'unavailable') {
            setFailure('unavailable');
            callbacks.current.onUnavailable?.();
          } else setFailure('failed');
        },
      );
    },
    [language],
  );

  const recorder = useVoiceRecorder({
    silenceMs: Number.POSITIVE_INFINITY,
    onFinished: upload,
  });
  const {
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
  } = recorder;

  const start = useCallback(async () => {
    if (holding.current) return;
    holding.current = true;
    setFailure(null);
    const started = await startRecording();
    // Released while the permission prompt or the recorder was starting: nobody holds it.
    if (started && !holding.current) await cancelRecording();
  }, [startRecording, cancelRecording]);

  const stop = useCallback(() => {
    holding.current = false;
    void stopRecording();
  }, [stopRecording]);

  const cancel = useCallback(() => {
    holding.current = false;
    attempt.current++;
    setTranscribing(false);
    void cancelRecording();
  }, [cancelRecording]);

  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );

  const error: ServerVoiceError | null =
    recorder.status === 'denied'
      ? 'permission'
      : recorder.status === 'error'
        ? 'failed'
        : failure;

  return {
    available: recorderAvailable(undefined),
    listening:
      recorder.status === 'recording' || recorder.status === 'starting',
    transcribing,
    error,
    start,
    stop,
    cancel,
  };
}
