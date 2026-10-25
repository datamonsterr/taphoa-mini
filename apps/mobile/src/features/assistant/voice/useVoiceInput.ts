import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';

import { capture } from '@/lib/analytics';
import type { Language } from '@/stores/settings';

export type VoiceLocale = 'vi-VN' | 'en-US';
/** `permission`: microphone or speech access denied. `failed`: any other engine error. */
export type VoiceError = 'permission' | 'failed';

export type UseVoiceInputOptions = {
  language: Language;
  /** Called with the running transcript (finished segments plus the current partial). */
  onPartial?: (text: string) => void;
  /** Called once per hold with the final transcript, only when it is not empty. */
  onFinal: (text: string) => void;
};

export type VoiceInput = {
  available: boolean;
  listening: boolean;
  partial: string;
  error: VoiceError | null;
  /** Hold started. Resolves once recognition was started or refused. */
  start: () => Promise<void>;
  /** Hold released: the final transcript goes to `onFinal`. */
  stop: () => void;
  /** Abort without `onFinal`. */
  cancel: () => void;
};

export const voiceLocale = (language: Language): VoiceLocale =>
  language === 'vi' ? 'vi-VN' : 'en-US';

// Finished segments cover separate utterances, so they are joined, never replaced.
const join = (a: string, b: string) => [a, b].filter(Boolean).join(' ');

function readAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

function readOnDevice(): boolean {
  try {
    return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
  } catch {
    return false;
  }
}

// Not errors for the user: the engine simply heard nothing.
const SILENT_CODES = new Set(['no-speech', 'speech-timeout', 'aborted']);

/** Hold-to-talk dictation on top of expo-speech-recognition. Never sends anything itself. */
export function useVoiceInput({
  language,
  onPartial,
  onFinal,
}: UseVoiceInputOptions): VoiceInput {
  const [available] = useState(readAvailable);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<VoiceError | null>(null);

  const callbacks = useRef({ onPartial, onFinal });
  useEffect(() => {
    callbacks.current = { onPartial, onFinal };
  });

  /** True from `start()` until the hold ends; lets a quick release beat the permission prompt. */
  const holding = useRef(false);
  /** True while a recognition session is live (between `module.start` and `end`). */
  const active = useRef(false);
  const permitted = useRef(false);
  const locale = useRef<VoiceLocale>('vi-VN');
  const startedAt = useRef(0);
  const committed = useRef('');
  const current = useRef('');
  const failure = useRef<VoiceError | null>(null);

  const reset = useCallback(() => {
    holding.current = false;
    active.current = false;
    setListening(false);
    setPartial('');
  }, []);

  useSpeechRecognitionEvent('start', () => {
    if (active.current) setListening(true);
  });

  useSpeechRecognitionEvent('result', (event) => {
    if (!active.current) return;
    const text = event.results[0]?.transcript?.trim() ?? '';
    if (event.isFinal) {
      committed.current = join(committed.current, text);
      current.current = '';
    } else {
      current.current = text;
    }
    const running = join(committed.current, current.current);
    setPartial(running);
    callbacks.current.onPartial?.(running);
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!active.current || SILENT_CODES.has(event.error)) return;
    failure.current = event.error === 'not-allowed' ? 'permission' : 'failed';
    setError(failure.current);
  });

  useSpeechRecognitionEvent('end', () => {
    if (!active.current) return;
    const text = join(committed.current, current.current).trim();
    const ok = text !== '' && failure.current === null;
    capture('voice_input_used', {
      duration_ms: Math.max(0, Date.now() - startedAt.current),
      language: locale.current,
      ok,
    });
    reset();
    if (ok) callbacks.current.onFinal(text);
  });

  const start = useCallback(async () => {
    if (holding.current) return;
    holding.current = true;
    setError(null);
    if (!permitted.current) {
      let granted = false;
      try {
        granted = (await ExpoSpeechRecognitionModule.requestPermissionsAsync())
          .granted;
      } catch {
        granted = false;
      }
      if (!granted) {
        holding.current = false;
        setError('permission');
        return;
      }
      permitted.current = true;
    }
    // Released while the permission prompt was open: do not start a session nobody holds.
    if (!holding.current) return;
    locale.current = voiceLocale(language);
    committed.current = '';
    current.current = '';
    failure.current = null;
    startedAt.current = Date.now();
    active.current = true;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: locale.current,
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: readOnDevice(),
        addsPunctuation: true,
      });
    } catch {
      reset();
      setError('failed');
    }
  }, [language, reset]);

  const stop = useCallback(() => {
    holding.current = false;
    if (active.current) ExpoSpeechRecognitionModule.stop();
  }, []);

  const cancel = useCallback(() => {
    const wasActive = active.current;
    reset();
    if (wasActive) ExpoSpeechRecognitionModule.abort();
  }, [reset]);

  useEffect(
    () => () => {
      if (active.current) ExpoSpeechRecognitionModule.abort();
    },
    [],
  );

  return { available, listening, partial, error, start, stop, cancel };
}
