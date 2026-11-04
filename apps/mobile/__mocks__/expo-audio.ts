/* eslint-disable @typescript-eslint/no-require-imports -- the hooks require React lazily */
/**
 * Jest double for `expo-audio`, applied automatically (root `__mocks__` next to `node_modules`).
 * Tests reach the controls through `import { audioMock } from '@/test/audio'` and call
 * `audioMock.reset()` in `beforeEach`.
 */
type RecorderState = {
  canRecord: boolean;
  isRecording: boolean;
  durationMillis: number;
  fileSize: number;
  mediaServicesDidReset: boolean;
  metering?: number;
  url: string | null;
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

const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((fn) => fn());

let state: RecorderState;
let nextUri = 'file:///cache/two-line-sale.m4a';

export const recorder = {
  uri: null as string | null,
  isRecording: false,
  currentTime: 0,
  prepareToRecordAsync: jest.fn(),
  record: jest.fn(),
  recordForDuration: jest.fn(),
  pause: jest.fn(),
  stop: jest.fn(),
  getStatus: jest.fn(() => state),
};

export const requestRecordingPermissionsAsync = jest.fn();
export const getRecordingPermissionsAsync = jest.fn();
export const setAudioModeAsync = jest.fn();

export const RecordingPresets = {
  HIGH_QUALITY: {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
    android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
    ios: { audioQuality: 127 },
    web: {},
  },
};

function set(next: Partial<RecorderState>) {
  state = { ...state, ...next };
  notify();
}

/** Sets every mock back to: permission undetermined-but-grantable, idle recorder. */
function reset() {
  subscribers.clear();
  nextUri = 'file:///cache/two-line-sale.m4a';
  state = {
    canRecord: false,
    isRecording: false,
    durationMillis: 0,
    fileSize: 0,
    mediaServicesDidReset: false,
    url: null,
  };
  recorder.uri = null;
  recorder.isRecording = false;
  recorder.prepareToRecordAsync.mockReset().mockImplementation(async () => {
    set({ canRecord: true });
  });
  recorder.record.mockReset().mockImplementation(() => {
    recorder.isRecording = true;
    set({ isRecording: true });
  });
  recorder.recordForDuration.mockReset();
  recorder.pause.mockReset();
  recorder.stop.mockReset().mockImplementation(async () => {
    recorder.isRecording = false;
    recorder.uri = nextUri;
    set({ isRecording: false, url: nextUri });
  });
  recorder.getStatus.mockReset().mockImplementation(() => state);
  requestRecordingPermissionsAsync.mockReset().mockResolvedValue(granted);
  getRecordingPermissionsAsync.mockReset().mockResolvedValue({
    ...granted,
    granted: false,
    status: 'undetermined',
  });
  setAudioModeAsync.mockReset().mockResolvedValue(undefined);
}
reset();

export function useAudioRecorder() {
  return recorder;
}

export function useAudioRecorderState(): RecorderState {
  const React = require('react') as typeof import('react');
  const [value, setValue] = React.useState(state);
  React.useEffect(() => {
    const update = () => setValue(state);
    subscribers.add(update);
    update();
    return () => {
      subscribers.delete(update);
    };
  }, []);
  return value;
}

/** Test controls: meter levels, permissions and the file a stopped recording leaves. */
export const audioMock = {
  recorder,
  reset,
  /** Current input level in dBFS (-160 silence ... 0 clipping), as `metering` reports it. */
  setMetering(db: number | undefined) {
    set({ metering: db });
  },
  /** The `uri` of the next finished recording; its file name picks the mock's canned reply. */
  setNextUri(uri: string) {
    nextUri = uri;
  },
  /** Permission already granted (no prompt) or the next request is answered granted/denied. */
  setPermission(
    mode: 'granted' | 'prompt-granted' | 'prompt-denied' | 'denied',
  ) {
    getRecordingPermissionsAsync.mockResolvedValue(
      mode === 'granted'
        ? granted
        : mode === 'denied'
          ? denied
          : { ...granted, granted: false, status: 'undetermined' },
    );
    requestRecordingPermissionsAsync.mockResolvedValue(
      mode === 'granted' || mode === 'prompt-granted' ? granted : denied,
    );
  },
};
