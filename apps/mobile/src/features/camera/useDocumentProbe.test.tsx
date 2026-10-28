import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { ApiError, useProbeDocument } from '@/lib/api';

import * as capture from './capture';
import { PROBE_INTERVAL_MS, useDocumentProbe } from './useDocumentProbe';

jest.mock('@/lib/api/documentProbes', () => ({ useProbeDocument: jest.fn() }));
jest.mock('./capture', () => ({
  takeProbePhoto: jest.fn(),
  discardProbePhoto: jest.fn(),
  toUploadFile: jest.fn((photo) => ({
    uri: photo.uri,
    name: 'scan.jpg',
    type: 'image/jpeg',
  })),
}));

const photo = { uri: 'file:///probe.jpg', width: 480, height: 640 };
const document = {
  detected: true,
  score: 0.9,
  text_lines: 12,
  line_boxes: [[0.1, 0.2, 0.6, 0.05]],
};
const mutateAsync = jest.fn();
const camera = { current: { takePictureAsync: jest.fn() } };
let onAppState: (state: AppStateStatus) => void;
const remove = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    writable: true,
    configurable: true,
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      onAppState = listener;
      return { remove };
    });
  jest.mocked(capture.takeProbePhoto).mockReset().mockResolvedValue(photo);
  jest.mocked(capture.discardProbePhoto).mockClear();
  mutateAsync.mockReset().mockResolvedValue(document);
  jest
    .mocked(useProbeDocument)
    .mockReturnValue({ mutateAsync } as unknown as ReturnType<
      typeof useProbeDocument
    >);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const tick = (ms = PROBE_INTERVAL_MS) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const mount = (enabled = true) =>
  renderHook((live: boolean) => useDocumentProbe(camera, live), {
    initialProps: enabled,
  });

test('silently captures and probes every 2.5 seconds, returning dimensions with the signal', async () => {
  const { result } = await mount();
  await tick(PROBE_INTERVAL_MS - 1);
  expect(mutateAsync).not.toHaveBeenCalled();
  await tick(1);
  expect(capture.takeProbePhoto).toHaveBeenCalledWith(camera.current);
  expect(mutateAsync).toHaveBeenCalledWith({
    image: { uri: photo.uri, name: 'scan.jpg', type: 'image/jpeg' },
    signal: expect.any(AbortSignal),
  });
  expect(result.current).toEqual({
    document,
    imageSize: { width: 480, height: 640 },
  });
  expect(capture.discardProbePhoto).toHaveBeenCalledWith(photo.uri);
  await tick();
  expect(mutateAsync).toHaveBeenCalledTimes(2);
});

test('one request in flight; pausing aborts it and discards stale results across resume', async () => {
  let release!: (value: typeof document) => void;
  mutateAsync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result, rerender } = await mount();
  await tick();
  await tick(20_000);
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  await rerender(false);
  expect(mutateAsync.mock.calls[0][0].signal.aborted).toBe(true);
  await rerender(true);
  await tick();
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  await act(async () => release(document));
  expect(result.current).toBeNull();
  await tick();
  expect(mutateAsync).toHaveBeenCalledTimes(2);
});

test('pauses for disabled live state, inactive/background app, and unmount', async () => {
  const { rerender, unmount } = await mount(false);
  await tick();
  expect(capture.takeProbePhoto).not.toHaveBeenCalled();
  await rerender(true);
  await act(async () => onAppState('inactive'));
  await tick();
  expect(mutateAsync).not.toHaveBeenCalled();
  await act(async () => onAppState('background'));
  await tick();
  expect(mutateAsync).not.toHaveBeenCalled();
  await act(async () => onAppState('active'));
  await tick();
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  await unmount();
  await tick();
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalled();
});

test('does not POST if paused while the silent still is being captured', async () => {
  let release!: (value: typeof photo) => void;
  jest.mocked(capture.takeProbePhoto).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { rerender } = await mount();
  await tick();
  await rerender(false);
  await act(async () => release(photo));
  expect(mutateAsync).not.toHaveBeenCalled();
  expect(capture.discardProbePhoto).toHaveBeenCalledWith(photo.uri);
});

test('503 disables probing for this mounted session, including after pause/resume', async () => {
  mutateAsync.mockRejectedValueOnce(
    new ApiError(503, { error: 'OCR missing', code: 'ocr_unavailable' }),
  );
  const { result, rerender } = await mount();
  await tick();
  await rerender(false);
  await rerender(true);
  await tick(120_000);
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  expect(result.current).toBeNull();
});

test('429 honours Retry-After across pause/resume, then probes again', async () => {
  mutateAsync.mockRejectedValueOnce(
    new ApiError(429, { error: 'rate limited' }, 15_000),
  );
  const { rerender } = await mount();
  await tick();
  await tick(5000);
  await rerender(false);
  await rerender(true);
  await tick(9999);
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(mutateAsync).toHaveBeenCalledTimes(2);
});

test('transient capture/network errors recover and a negative signal clears detection', async () => {
  jest
    .mocked(capture.takeProbePhoto)
    .mockRejectedValueOnce(new Error('camera unavailable'));
  mutateAsync.mockRejectedValueOnce(new Error('offline'));
  const { result } = await mount();
  await tick();
  await tick();
  await tick();
  expect(result.current?.document.detected).toBe(true);
  mutateAsync.mockResolvedValueOnce({
    ...document,
    detected: false,
    line_boxes: [],
    text_lines: 0,
  });
  await tick();
  expect(result.current?.document.detected).toBe(false);
});

test('a late 429 response from an interrupted request still prevents an early retry after resume', async () => {
  let reject!: (value: unknown) => void;
  mutateAsync.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      }),
  );
  const { rerender } = await mount();
  await tick();
  await rerender(false);
  await rerender(true);
  await act(async () =>
    reject(new ApiError(429, { error: 'limited' }, 10_000)),
  );
  await tick(9999);
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(mutateAsync).toHaveBeenCalledTimes(2);
});
