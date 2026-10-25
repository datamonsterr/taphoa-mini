import { useCallback, useEffect, useRef, useState } from 'react';

import { capture } from '@/lib/analytics';
import type { Language } from '@/stores/settings';

import { getSpeechModule, type SpeechModule } from './speechModule';

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

function readAvailable(speech: SpeechModule | null): boolean {
  try {
    return speech?.isRecognitionAvailable() ?? false;
  } catch {
    return false;
  }
}

function readOnDevice(speech: SpeechModule | null): boolean {
  try {
    return speech?.supportsOnDeviceRecognition() ?? false;
  } catch {
    return false;
  }
}

// Not errors for the user: the engine simply heard nothing.
const SILENT_CODES = new Set(['no-speech', 'speech-timeout', 'aborted']);

type SpeechEvents = {
  start: undefined;
  result: { isFinal: boolean; results: { transcript?: string }[] };
  error: { error: string };
  end: undefined;
};

/** Listens to one engine event for as long as the component lives; a no-op without the module. */
function useSpeechEvent<K extends keyof SpeechEvents>(
  speech: SpeechModule | null,
  name: K,
  handler: (event: SpeechEvents[K]) => void,
) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!speech) return;
    const subscription = (
      speech.addListener as (
        event: K,
        listener: (event: SpeechEvents[K]) => void,
      ) => { remove: () => void }
    )(name, (event) => latest.current(event));
    return () => subscription.remove();
  }, [speech, name]);
}

/** Hold-to-talk dictation on top of expo-speech-recognition. Never sends anything itself. */
export function useVoiceInput({
  language,
  onPartial,
  onFinal,
}: UseVoiceInputOptions): VoiceInput {
  const speech = getSpeechModule();
  const [available] = useState(() => readAvailable(speech));
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<VoiceError | null>(null);

  const callbacks = useRef({ onPartial, onFinal });
  useEffect(() => {
    callbacks.current = { onPartial, onFinal };
  });

  /** True from `start()` until the hold ends; lets a quick release beat the permission prompt. */
  const holding = useRef(false);
  /** True while `start()` runs (for example during the permission prompt). */
  const starting = useRef(false);
  /** True while a recognition session is live (between `module.start` and `end`). */
  const active = useRef(false);
  const permitted = useRef(false);
  const locale = useRef<VoiceLocale>('vi-VN');
  const startedAt = useRef(0);
  const committed = useRef('');
  const current = useRef('');
  const failure = useRef<VoiceError | null>(null);
  /** Whether the running session asked for on-device recognition. */
  const onDevice = useRef(false);
  /** True once the session was restarted without on-device recognition during this hold. */
  const fellBack = useRef(false);
  /** True once the running session produced a result. */
  const heard = useRef(false);
  /** An on-device start failed: restart in the network engine when the session ends. */
  const retryNetwork = useRef(false);

  const reset = useCallback(() => {
    holding.current = false;
    active.current = false;
    setListening(false);
    setPartial('');
  }, []);

  /** Starts a session with the current hold's settings; false when the engine throws. */
  const begin = useCallback(
    (requireOnDevice: boolean) => {
      onDevice.current = requireOnDevice;
      heard.current = false;
      try {
        if (!speech) return false;
        speech.start({
          lang: locale.current,
          interimResults: true,
          continuous: true,
          requiresOnDeviceRecognition: requireOnDevice,
          addsPunctuation: true,
        });
        return true;
      } catch {
        return false;
      }
    },
    [speech],
  );

  useSpeechEvent(speech, 'start', () => {
    if (active.current) setListening(true);
  });

  useSpeechEvent(speech, 'result', (event) => {
    if (!active.current) return;
    heard.current = true;
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

  useSpeechEvent(speech, 'error', (event) => {
    if (!active.current || SILENT_CODES.has(event.error)) return;
    // On-device start refused before anything was heard (for example `language-not-supported`):
    // not an error yet; `end` follows and restarts the session once in the network engine.
    if (
      event.error !== 'not-allowed' &&
      onDevice.current &&
      !fellBack.current &&
      !heard.current
    ) {
      retryNetwork.current = true;
      return;
    }
    failure.current = event.error === 'not-allowed' ? 'permission' : 'failed';
    setError(failure.current);
  });

  useSpeechEvent(speech, 'end', () => {
    if (!active.current) return;
    if (retryNetwork.current) {
      retryNetwork.current = false;
      if (holding.current) {
        fellBack.current = true;
        if (begin(false)) return;
      }
      failure.current = 'failed';
      setError('failed');
    }
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
    // A press during the permission prompt only re-arms the hold: the start in flight begins
    // the session, so two `speech.start` calls cannot happen.
    if (starting.current) return;
    starting.current = true;
    try {
      setError(null);
      if (!permitted.current) {
        let granted = false;
        try {
          granted = (await speech!.requestPermissionsAsync()).granted;
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
      fellBack.current = false;
      retryNetwork.current = false;
      active.current = true;
      if (!begin(readOnDevice(speech))) {
        reset();
        setError('failed');
      }
    } finally {
      starting.current = false;
    }
  }, [language, reset, begin, speech]);

  const stop = useCallback(() => {
    holding.current = false;
    if (active.current) speech?.stop();
  }, [speech]);

  const cancel = useCallback(() => {
    const wasActive = active.current;
    reset();
    if (wasActive) speech?.abort();
  }, [reset, speech]);

  useEffect(
    () => () => {
      if (active.current) speech?.abort();
    },
    [speech],
  );

  return { available, listening, partial, error, start, stop, cancel };
}
