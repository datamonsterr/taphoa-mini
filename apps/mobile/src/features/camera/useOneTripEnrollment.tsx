import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { onlineManager } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useVoiceRecorder } from '@/features/voice/useVoiceRecorder';
import { uploadUtterance } from '@/features/voice/api';
import type { VoiceClip } from '@/features/voice/fixture';
import { capture } from '@/lib/analytics';
import type { useUploadImage, Product } from '@/lib/api';
import { useSettingsStore } from '@/stores/settings';
import { colors } from '@/theme';
import { QuickEnrollSheet } from './QuickEnrollSheet';
import { discardProbePhoto } from './capture';
import {
  coverageSectors,
  coveragePrompt,
  stopDecision,
  voiceDraftToForm,
  MAX_KEYFRAMES,
  type Keyframe,
} from './vision/enrollment';
import { createUploadQueue } from './vision/uploadQueue';

type Phase = 'idle' | 'capturing' | 'retry' | 'voice' | 'form';
type Options = {
  enabled: boolean;
  upload: ReturnType<typeof useUploadImage>['mutateAsync'];
  onCreated: (product: Product) => void;
};
/** RN controller owns uploads, recording and cancellation; the preview owns frame work. */
export function useOneTripEnrollment({ enabled, upload, onCreated }: Options) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState(0);
  const [frames, setFrames] = useState<Keyframe[]>([]);
  const [sectors, setSectors] = useState<number[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [lost, setLost] = useState(false);
  const [draft, setDraft] = useState(() => voiceDraftToForm(undefined));
  const [voiceSuccess, setVoiceSuccess] = useState(false);
  const current = useRef({
    id: 0,
    phase: 'idle' as Phase,
    enabled,
    started: 0,
    seen: 0,
    frames: [] as Keyframe[],
    files: new Set<string>(),
    queue: createUploadQueue(),
  });
  const language = useSettingsStore((s) => s.language);
  const move = useCallback((next: Phase) => {
    current.current.phase = next;
    setPhase(next);
  }, []);
  const cancelVoice = useRef<() => Promise<void>>(async () => {});
  const clear = useCallback(() => {
    const old = current.current;
    current.current = {
      ...old,
      id: old.id + 1,
      phase: 'idle',
      frames: [],
      files: new Set(),
      queue: createUploadQueue(),
    };
    setSession(current.current.id);
    setFrames([]);
    setSectors([]);
    setLost(false);
    setElapsed(0);
    setPhase('idle');
    setDraft(voiceDraftToForm(undefined));
    setVoiceSuccess(false);
    void cancelVoice.current();
    void old.queue.drain().then(() => old.files.forEach(discardProbePhoto));
  }, []);
  useEffect(() => {
    current.current.enabled = enabled;
    if (!enabled) clear(); // Losing focus, permission or mode cancels this attempt.
  }, [enabled, clear]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') clear();
    });
    return () => listener.remove();
  }, [clear]);
  useEffect(
    () => () => {
      const old = current.current;
      old.enabled = false;
      // Keep the rendered generation consistent when StrictMode replays mount effects.
      // The disabled/idle guards invalidate late work without changing a state-backed id.
      old.phase = 'idle';
      void old.queue.drain().then(() => old.files.forEach(discardProbePhoto));
    },
    [],
  );
  const fallback = useCallback(() => {
    if (current.current.phase !== 'voice') return;
    move('form');
    void cancelVoice.current();
  }, [move]);
  const utterance = useCallback(
    async (clip: VoiceClip) => {
      const id = current.current.id;
      if (current.current.phase !== 'voice') return;
      try {
        const answer = await uploadUtterance({
          clip,
          mode: 'product',
          language,
          entry: 'control',
          screen: 'camera',
        });
        if (current.current.id !== id || current.current.phase !== 'voice')
          return;
        setDraft(voiceDraftToForm(answer.product_draft));
        setVoiceSuccess(!!answer.product_draft);
        move('form');
      } catch {
        if (current.current.id === id) fallback();
      }
    },
    [language, move, fallback],
  );
  const recorder = useVoiceRecorder({
    maxSeconds: 4,
    silenceMs: 700,
    onFinished: (clip) => void utterance(clip),
  });
  const {
    start: record,
    stop: stopRecording,
    cancel: cancelRecording,
  } = recorder;
  useEffect(() => {
    cancelVoice.current = cancelRecording;
  }, [cancelRecording]);
  const voiceStarted = useRef(-1);
  useEffect(() => {
    if (phase !== 'voice' || voiceStarted.current === session) return;
    voiceStarted.current = session;
    if (!onlineManager.isOnline()) {
      fallback();
      return;
    }
    void record().then((ok) => {
      if (!ok && current.current.id === session) fallback();
    });
  }, [phase, session, record, fallback]);
  useEffect(() => {
    if (phase !== 'voice') return;
    // Covers permission waits, silence with no clip, and an unresponsive network.
    const timer = setTimeout(fallback, 8000);
    return () => clearTimeout(timer);
  }, [phase, fallback]);

  const stop = useCallback(
    (manual = false) => {
      const state = current.current;
      if (state.phase !== 'capturing') return;
      const result = stopDecision(
        Date.now() - state.started,
        state.frames.length,
        manual,
      );
      if (result === 'complete') move('voice');
      else if (result === 'retry') move('retry');
    },
    [move],
  );
  useEffect(() => {
    if (phase !== 'capturing') return;
    const timer = setInterval(() => {
      const state = current.current;
      setElapsed(Date.now() - state.started);
      setLost(Date.now() - state.seen > 1000);
      stop();
    }, 100);
    return () => clearInterval(timer);
  }, [phase, stop]);
  const start = useCallback(() => {
    const state = current.current;
    if (!state.enabled || state.phase !== 'idle') return;
    state.started = Date.now();
    state.seen = state.started;
    move('capturing');
  }, [move]);
  const enqueue = useCallback(
    (frame: Keyframe, id: number) => {
      const state = current.current;
      frame.error = false;
      void state.queue.add(async () => {
        if (current.current.id !== id || !current.current.enabled) return;
        try {
          if (!onlineManager.isOnline()) throw new Error('offline');
          const image = await upload({
            file: { uri: frame.uri, name: 'keyframe.jpg', type: 'image/jpeg' },
            purpose: 'enrollment',
          });
          frame.imageId = image.id;
        } catch {
          frame.error = true;
        }
        if (current.current.id === id && current.current.enabled)
          setFrames([...state.frames]);
      });
    },
    [upload],
  );
  const onFrame = useCallback(
    (id: number, frame: Keyframe) => {
      const state = current.current;
      if (
        id !== state.id ||
        !state.enabled ||
        state.phase !== 'capturing' ||
        state.frames.length >= MAX_KEYFRAMES
      ) {
        discardProbePhoto(frame.uri);
        return;
      }
      state.frames.push(frame);
      state.files.add(frame.uri);
      setFrames([...state.frames]);
      setSectors((previous) => [
        ...new Set([
          ...previous,
          ...coverageSectors(state.frames[0].bbox, frame.bbox),
        ]),
      ]);
      enqueue(frame, id);
      stop();
    },
    [enqueue, stop],
  );
  const onTrack = useCallback((id: number, lastSeen: number) => {
    if (id !== current.current.id || current.current.phase !== 'capturing')
      return;
    current.current.seen = lastSeen;
    setLost(Date.now() - lastSeen > 1000);
  }, []);
  const prompt = lost
    ? 'Giữ sản phẩm trong khung'
    : elapsed >= 10000
      ? 'Xoay chậm hơn'
      : coveragePrompt(sectors);
  useEffect(() => {
    if (enabled && phase === 'capturing')
      void Haptics.selectionAsync().catch(() => {});
  }, [prompt, enabled, phase]);
  const retryUploads = () =>
    frames
      .filter((frame) => frame.error)
      .forEach((frame) => enqueue(frame, session));
  const failed = frames.some((frame) => frame.error);
  const uploading = frames.some((frame) => !frame.imageId && !frame.error);
  return {
    detect: enabled && (phase === 'idle' || phase === 'capturing'),
    busy: enabled && phase !== 'idle',
    cancel: clear,
    previewProps: {
      enrollment: enabled
        ? {
            id: session,
            armed: phase === 'idle',
            capturing: phase === 'capturing',
          }
        : undefined,
      onEnrollmentStart: start,
      onEnrollmentFrame: onFrame,
      onEnrollmentTrack: onTrack,
    },
    overlay:
      enabled && phase === 'capturing' ? (
        <View pointerEvents="none" style={styles.ring}>
          <View
            testID="coverage-ring"
            accessibilityLabel={`${frames.length} khung hình, ${sectors.length} trên 8 góc`}
            accessibilityState={{ busy: !lost }}
          >
            <Svg width={140} height={140} viewBox="0 0 140 140">
              {Array.from({ length: 8 }, (_, sector) => (
                <Circle
                  key={sector}
                  cx={70}
                  cy={70}
                  r={62}
                  fill="none"
                  stroke={
                    sectors.includes(sector) ? colors.accent : '#ffffff55'
                  }
                  strokeWidth={6}
                  strokeDasharray="42 348"
                  rotation={sector * 45 - 90}
                  origin="70,70"
                />
              ))}
            </Svg>
          </View>
        </View>
      ) : null,
    hint: enabled ? (
      <View accessibilityLiveRegion="polite">
        <Text style={styles.text}>
          {phase === 'idle'
            ? 'Chạm vào khung sản phẩm'
            : phase === 'capturing'
              ? prompt
              : phase === 'retry'
                ? 'Chưa đủ 8 khung hình. Thử lại'
                : ''}
        </Text>
        {phase === 'capturing' ? (
          <Text style={styles.text}>{frames.length}/24</Text>
        ) : null}
      </View>
    ) : null,
    controls: enabled ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={phase === 'capturing' ? 'Dừng chụp' : 'Thử lại'}
        testID="one-trip-stop"
        disabled={phase !== 'capturing' && phase !== 'retry'}
        onPress={() => (phase === 'retry' ? clear() : stop(true))}
        style={styles.control}
      >
        <Text style={styles.text}>
          {phase === 'capturing'
            ? 'Dừng'
            : phase === 'retry'
              ? 'Thử lại'
              : 'Chạm khung'}
        </Text>
      </Pressable>
    ) : null,
    sheet:
      enabled && phase === 'voice' ? (
        <View style={styles.voice} accessibilityViewIsModal>
          <Text style={styles.text}>Tên và giá?</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Xong"
            onPress={() => void stopRecording()}
          >
            <Text style={styles.text}>Xong</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Nhập bằng bàn phím"
            onPress={fallback}
          >
            <Text style={styles.text}>Nhập bằng bàn phím</Text>
          </Pressable>
        </View>
      ) : enabled && phase === 'form' ? (
        <View style={StyleSheet.absoluteFill}>
          <QuickEnrollSheet
            oneTrip={{ frames, draft, voiceSuccess }}
            onAddPhoto={() => {}}
            onClose={clear}
            onCreated={(product) => {
              capture('one_trip_enrollment_completed', {
                duration_ms: Date.now() - current.current.started,
                keyframe_count: frames.length,
                voice_success: voiceSuccess,
              });
              onCreated(product);
              clear();
            }}
          />
          {failed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Tải lại ảnh"
              onPress={retryUploads}
              style={styles.upload}
            >
              <Text>Tải lại ảnh</Text>
            </Pressable>
          ) : uploading ? (
            <Text style={styles.upload}>Đang tải ảnh…</Text>
          ) : null}
        </View>
      ) : null,
  };
}
const styles = StyleSheet.create({
  text: { color: 'white', textAlign: 'center', fontSize: 16 },
  control: {
    minHeight: 72,
    minWidth: 100,
    justifyContent: 'center',
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: 36,
  },
  ring: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voice: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.cameraBg,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
  },
  upload: {
    position: 'absolute',
    top: 24,
    alignSelf: 'center',
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: 16,
  },
});
