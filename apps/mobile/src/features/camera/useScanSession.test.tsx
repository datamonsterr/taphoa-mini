import { act, renderHook } from '@testing-library/react-native';
import { useCreateScan } from '@/lib/api';
import { setAnalyticsSink } from '@/lib/analytics';
import { candidate, detection, scan } from './testing';
import { useScanSession, SCAN_TIMEOUT_MS } from './useScanSession';

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  useCreateScan: jest.fn(),
}));
const mutateAsync = jest.fn();
const boxes = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, track_id: 2 }];
const shot = { uri: 'file:///native.jpg', width: 960, height: 1280, boxes };
const camera = { current: { takePictureAsync: jest.fn(async () => shot) } };
const event = jest.fn();
beforeEach(() => {
  mutateAsync
    .mockReset()
    .mockResolvedValue(scan([detection('d', { track_id: 2 })]));
  jest
    .mocked(useCreateScan)
    .mockReturnValue({ mutateAsync } as unknown as ReturnType<
      typeof useCreateScan
    >);
  camera.current.takePictureAsync.mockClear();
  setAnalyticsSink({ capture: event });
  event.mockClear();
});
afterEach(() => {
  setAnalyticsSink(null);
  jest.restoreAllMocks();
});
it('uploads the upright photo with its shutter-time boxes and records trigger-to-result latency', async () => {
  let clock = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  camera.current.takePictureAsync.mockImplementationOnce(async () => {
    clock = 600;
    return shot;
  });
  mutateAsync.mockImplementationOnce(async () => {
    clock = 1600;
    return scan([detection('d', { track_id: 2 })]);
  });
  const { result } = await renderHook(() => useScanSession(camera));
  await act(async () => {
    await result.current.capture(undefined, 'auto');
  });
  expect(mutateAsync).toHaveBeenCalledWith({
    image: { uri: shot.uri, type: 'image/jpeg', name: 'scan.jpg' },
    mode: 'multi',
    boxes,
  });
  expect(result.current.state.phase).toBe('result');
  expect(event).toHaveBeenCalledWith('scan_result_received', {
    trigger: 'auto',
    latency_ms: 1500,
  });
});
it('serializes concurrent shutter/auto callbacks and keeps per-track votes across live resets', async () => {
  const { result } = await renderHook(() => useScanSession(camera));
  const response = (p: string) =>
    scan([detection('d', { track_id: 2, candidates: [candidate(p, 10)] })]);
  mutateAsync
    .mockResolvedValueOnce(response('a'))
    .mockResolvedValueOnce(response('a'))
    .mockResolvedValueOnce(response('b'));
  await act(async () => {
    await Promise.all([
      result.current.capture(),
      result.current.capture(undefined, 'auto'),
    ]);
  });
  expect(camera.current.takePictureAsync).toHaveBeenCalledTimes(1);
  await act(() => result.current.reset());
  await act(async () => {
    await result.current.capture();
  });
  await act(() => result.current.reset());
  await act(async () => {
    await result.current.capture();
  });
  expect(
    result.current.state.scan!.detections[0]!.candidates[0]!.product_id,
  ).toBe('a');
});
it('does not record stale or timed-out results as successful C3 measurements', async () => {
  jest.useFakeTimers();
  let release!: (value: ReturnType<typeof scan>) => void;
  mutateAsync.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result } = await renderHook(() => useScanSession(camera));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.capture();
    await Promise.resolve();
  });
  await act(() => jest.advanceTimersByTime(SCAN_TIMEOUT_MS));
  expect(result.current.state.phase).toBe('error');
  await act(async () => {
    release(scan([]));
    await pending;
  });
  expect(event).not.toHaveBeenCalled();
});

it('ignores an answer received after leaving the camera session', async () => {
  let release!: (value: ReturnType<typeof scan>) => void;
  mutateAsync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result, unmount } = await renderHook(() => useScanSession(camera));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.capture();
    await Promise.resolve();
  });
  await unmount();
  await act(async () => {
    release(scan([]));
    await pending;
  });
  expect(event).not.toHaveBeenCalled();
});
