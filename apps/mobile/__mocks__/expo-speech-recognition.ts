/* eslint-disable @typescript-eslint/no-require-imports -- the hook mock requires React lazily */
/**
 * Jest double for `expo-speech-recognition`, applied automatically (root `__mocks__` next to
 * `node_modules`). Tests reach the controls through
 * `import { speechMock } from '@/test/speech'` and call `speechMock.reset()` in
 * `beforeEach`.
 */
type Listener = (payload: unknown) => void;
type EventName =
  'start' | 'result' | 'error' | 'end' | 'audiostart' | 'audioend' | 'nomatch';

const listeners = new Map<string, Set<Listener>>();

const subscribe = (name: string, listener: Listener) => {
  const set = listeners.get(name) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(name, set);
  return { remove: () => set.delete(listener) };
};

const granted = {
  granted: true,
  status: 'granted',
  canAskAgain: true,
  expires: 'never',
};
const denied = {
  granted: false,
  status: 'denied',
  canAskAgain: false,
  expires: 'never',
};

export const ExpoSpeechRecognitionModule = {
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  isRecognitionAvailable: jest.fn(),
  supportsOnDeviceRecognition: jest.fn(),
  addListener: jest.fn(subscribe),
};

/** Sets every mock back to: available, permission granted, no on-device support, no listeners. */
function reset() {
  listeners.clear();
  const m = ExpoSpeechRecognitionModule;
  m.start.mockReset();
  m.stop.mockReset();
  m.abort.mockReset();
  m.requestPermissionsAsync.mockReset().mockResolvedValue(granted);
  m.getPermissionsAsync.mockReset().mockResolvedValue(granted);
  m.isRecognitionAvailable.mockReset().mockReturnValue(true);
  m.supportsOnDeviceRecognition.mockReset().mockReturnValue(false);
  m.addListener.mockReset().mockImplementation(subscribe);
}
reset();

/** Test controls. Emit native events; flip availability, on-device support and permissions. */
export const speechMock = {
  module: ExpoSpeechRecognitionModule,
  reset,
  /** Delivers a native event (`start`, `result`, `error`, `end`, ...) to current listeners. */
  emit(name: EventName, payload: unknown = null) {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
  },
  emitStart() {
    speechMock.emit('start');
  },
  emitResult(transcript: string, isFinal = false) {
    speechMock.emit('result', {
      isFinal,
      results: [{ transcript, confidence: isFinal ? 0.9 : 0, segments: [] }],
    });
  },
  emitError(error: string, message = error) {
    speechMock.emit('error', { error, message });
  },
  emitEnd() {
    speechMock.emit('end');
  },
  setAvailable(value: boolean) {
    ExpoSpeechRecognitionModule.isRecognitionAvailable.mockReturnValue(value);
  },
  setOnDevice(value: boolean) {
    ExpoSpeechRecognitionModule.supportsOnDeviceRecognition.mockReturnValue(
      value,
    );
  },
  /** The next and later `requestPermissionsAsync()` calls resolve granted or denied. */
  setPermission(allowed: boolean) {
    ExpoSpeechRecognitionModule.requestPermissionsAsync.mockResolvedValue(
      allowed ? granted : denied,
    );
  },
  listenerCount(name: EventName) {
    return listeners.get(name)?.size ?? 0;
  },
};

export function useSpeechRecognitionEvent(
  name: EventName,
  listener: Listener,
): void {
  const React = require('react') as typeof import('react');
  const ref = React.useRef(listener);
  ref.current = listener;
  React.useEffect(() => {
    const sub = ExpoSpeechRecognitionModule.addListener(name, (payload) =>
      ref.current(payload),
    );
    return () => {
      sub.remove();
    };
  }, [name]);
}
