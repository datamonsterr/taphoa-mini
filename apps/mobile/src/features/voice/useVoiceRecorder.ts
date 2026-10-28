import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { fixtureClip, type VoiceClip } from './fixture';

/** AAC in an m4a, 16 kHz mono 32 kbps: about 4 KB a second, so 30 s stays far under 1 MB. */
export const VOICE_RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
};

export const MAX_SECONDS = 30;
/** Stop this long after the last loud sound, once something was heard. */
export const SILENCE_MS = 2000;
/** Input level (dBFS) above which the seller counts as speaking. */
export const SPEECH_DB = -35;
/** A tap shorter than this is not an utterance. */
const MIN_CLIP_MS = 300;
const TICK_MS = 100;
const FLOOR_DB = -60;

export type RecorderStatus =
  'idle' | 'starting' | 'recording' | 'denied' | 'error';

export type UseVoiceRecorderOptions = {
  /** Fixture clip name (dev and e2e only) used instead of the microphone. */
  fixture?: string;
  maxSeconds?: number;
  silenceMs?: number;
  /** Called once with the clip when a recording ends by `stop`, silence or the time cap. */
  onFinished?: (clip: VoiceClip) => void;
};

export type VoiceRecorder = {
  /** False on the web without a fixture: the browser has no m4a recorder, so the screen uses speech recognition. */
  available: boolean;
  status: RecorderStatus;
  /** 0..1, from the metering. */
  level: number;
  elapsedMs: number;
  maxMs: number;
  /** Resolves true once recording runs. */
  start: () => Promise<boolean>;
  /** Ends the recording and delivers the clip (also through `onFinished`). */
  stop: () => Promise<VoiceClip | null>;
  /** Throws the recording away; `onFinished` is not called. */
  cancel: () => Promise<void>;
};

const baseName = (uri: string) => uri.split('/').pop() || 'utterance.m4a';
const normalise = (db: number) =>
  Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));

export function useVoiceRecorder({
  fixture,
  maxSeconds = MAX_SECONDS,
  silenceMs = SILENCE_MS,
  onFinished,
}: UseVoiceRecorderOptions = {}): VoiceRecorder {
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const state = useAudioRecorderState(recorder, TICK_MS);
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const latest = useRef(onFinished);
  useEffect(() => {
    latest.current = onFinished;
  });

  const live = useRef(false);
  const token = useRef(0);
  const startedAt = useRef(0);
  const heard = useRef(false);
  const lastLoud = useRef(0);
  const sawRecording = useRef(false);
  const timers = useRef<{
    cap?: ReturnType<typeof setTimeout>;
    tick?: ReturnType<typeof setInterval>;
  }>({});
  const finishRef = useRef<(deliver: boolean) => Promise<VoiceClip | null>>(
    async () => null,
  );

  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.cap);
    clearInterval(timers.current.tick);
    timers.current = {};
  }, []);

  const finish = useCallback(
    async (deliver: boolean): Promise<VoiceClip | null> => {
      if (!live.current) return null;
      live.current = false;
      clearTimers();
      const durationMs = Date.now() - startedAt.current;
      let clip: VoiceClip | null = null;
      if (fixture) {
        clip = fixtureClip(fixture);
      } else {
        try {
          await recorder.stop();
          const uri = recorder.uri;
          if (uri)
            clip = { uri, name: baseName(uri), type: 'audio/mp4', durationMs };
        } catch {
          clip = null;
        }
      }
      setStatus('idle');
      setLevel(0);
      if (!deliver || !clip || (!clip.fixture && durationMs < MIN_CLIP_MS))
        return null;
      latest.current?.(clip);
      return clip;
    },
    [clearTimers, fixture, recorder],
  );
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  const begin = useCallback(() => {
    live.current = true;
    startedAt.current = Date.now();
    lastLoud.current = startedAt.current;
    heard.current = false;
    sawRecording.current = false;
    setElapsedMs(0);
    setStatus('recording');
    timers.current.cap = setTimeout(
      () => void finishRef.current(true),
      maxSeconds * 1000,
    );
    timers.current.tick = setInterval(() => {
      const now = Date.now();
      setElapsedMs(now - startedAt.current);
      if (!fixture && heard.current && now - lastLoud.current >= silenceMs)
        void finishRef.current(true);
    }, TICK_MS);
  }, [fixture, maxSeconds, silenceMs]);

  const start = useCallback(async () => {
    if (live.current || status === 'starting') return false;
    if (fixture) {
      begin();
      return true;
    }
    const mine = ++token.current;
    setStatus('starting');
    try {
      let { granted } = await getRecordingPermissionsAsync();
      if (!granted) ({ granted } = await requestRecordingPermissionsAsync());
      if (mine !== token.current) return false;
      if (!granted) {
        setStatus('denied');
        return false;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      if (mine !== token.current) return false;
      recorder.record({ forDuration: maxSeconds });
      begin();
      return true;
    } catch {
      if (mine === token.current) setStatus('error');
      return false;
    }
  }, [begin, fixture, maxSeconds, recorder, status]);

  const stop = useCallback(() => finish(true), [finish]);

  const cancel = useCallback(async () => {
    token.current++;
    if (live.current) await finish(false);
    else setStatus('idle');
  }, [finish]);

  // Metering drives the level bars and the silence rule; the recorder ending by itself (the
  // `forDuration` cap, an interruption) finishes the clip like a stop.
  useEffect(() => {
    if (!live.current || fixture) return;
    if (state.isRecording) sawRecording.current = true;
    else if (sawRecording.current) {
      void finishRef.current(true);
      return;
    }
    const db = state.metering;
    if (db === undefined || db === null) return;
    setLevel(normalise(db));
    if (db > SPEECH_DB) {
      heard.current = true;
      lastLoud.current = Date.now();
    }
  }, [state, fixture]);

  useEffect(
    () => () => {
      token.current++;
      clearTimeout(timers.current.cap);
      clearInterval(timers.current.tick);
      if (live.current) {
        live.current = false;
        void Promise.resolve(recorder.stop()).catch(() => undefined);
      }
    },
    [recorder],
  );

  return {
    available: Platform.OS !== 'web' || fixture !== undefined,
    status,
    level,
    elapsedMs,
    maxMs: maxSeconds * 1000,
    start,
    stop,
    cancel,
  };
}
