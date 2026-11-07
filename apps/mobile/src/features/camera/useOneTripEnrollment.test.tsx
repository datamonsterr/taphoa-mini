import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StrictMode, useEffect } from 'react';
import { QuickEnrollSheet } from './QuickEnrollSheet';
import { useOneTripEnrollment } from './useOneTripEnrollment';
import type { useUploadImage } from '@/lib/api';
import { uploadUtterance } from '@/features/voice/api';
import type { VoiceClip } from '@/features/voice/fixture';

const mockRecord = jest.fn(async () => true);
const mockCancel = jest.fn(async () => {});
let mockFinished: (clip: VoiceClip) => void;
jest.mock('@/features/voice/useVoiceRecorder', () => ({
  useVoiceRecorder: (options: { onFinished: typeof mockFinished }) => {
    mockFinished = options.onFinished;
    return {
      start: mockRecord,
      cancel: mockCancel,
      stop: jest.fn(),
      status: 'recording',
    };
  },
}));
jest.mock('@/features/voice/api', () => ({ uploadUtterance: jest.fn() }));
jest.mock('./QuickEnrollSheet', () => ({
  QuickEnrollSheet: jest.fn(() => null),
}));
let controller: ReturnType<typeof useOneTripEnrollment>;
const upload = jest.fn(async () => ({
  id: 'uploaded',
})) as unknown as ReturnType<typeof useUploadImage>['mutateAsync'];
function Harness({ enabled = true }: { enabled?: boolean }) {
  const value = useOneTripEnrollment({ enabled, upload, onCreated: jest.fn() });
  useEffect(() => {
    controller = value;
  });
  return (
    <>
      {value.hint}
      {value.controls}
      {value.sheet}
    </>
  );
}
const frame = () => ({
  uri: 'file:///keyframe.jpg',
  width: 1024,
  height: 768,
  bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
});
async function begin(count = 0) {
  await act(() => controller.previewProps.onEnrollmentStart());
  const id = controller.previewProps.enrollment!.id;
  for (let i = 0; i < count; i++)
    await act(() => controller.previewProps.onEnrollmentFrame(id, frame()));
  return id;
}
beforeEach(() => {
  jest.useFakeTimers();
  mockRecord.mockReset().mockResolvedValue(true);
  mockCancel.mockClear();
  jest.mocked(uploadUtterance).mockReset();
  jest.mocked(upload).mockClear();
});
it('extends under eight at 10s, then offers retry at 15s and requires a new lock', async () => {
  await render(<Harness />);
  const id = await begin(7);
  await act(() => jest.advanceTimersByTime(10000));
  await act(() => controller.previewProps.onEnrollmentTrack(id, Date.now()));
  expect(screen.getByText('Xoay chậm hơn')).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTime(5000));
  expect(screen.getByText('Chưa đủ 8 khung hình. Thử lại')).toBeOnTheScreen();
  expect(mockRecord).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Thử lại'));
  expect(controller.previewProps.enrollment?.armed).toBe(true);
});
it('auto stops at 10s with eight, and falls back on microphone denial', async () => {
  mockRecord.mockResolvedValue(false);
  await render(<Harness />);
  await begin(8);
  await act(() => jest.advanceTimersByTime(10000));
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Tên và giá?')).toBeNull();
  expect(controller.detect).toBe(false);
});
it('auto stops at 24, bounds late frames, and never waits forever for an utterance', async () => {
  await render(<Harness />);
  const id = await begin(24);
  expect(screen.getByText('Tên và giá?')).toBeOnTheScreen();
  await act(() => controller.previewProps.onEnrollmentFrame(id, frame()));
  expect(mockRecord).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTime(8000));
  expect(screen.queryByText('Tên và giá?')).toBeNull();
  expect(mockCancel).toHaveBeenCalled();
});
it('drops a late voice response and keyframe after focus loss', async () => {
  let release!: (answer: Awaited<ReturnType<typeof uploadUtterance>>) => void;
  jest.mocked(uploadUtterance).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = await render(<Harness />);
  const id = await begin(24);
  await act(() =>
    mockFinished({
      uri: 'file:///voice',
      name: 'voice.m4a',
      type: 'audio/mp4',
      durationMs: 1000,
    }),
  );
  await view.rerender(<Harness enabled={false} />);
  await act(() => {
    release({
      product_draft: { name: 'Late', price: 5000, unit: null },
    } as Awaited<ReturnType<typeof uploadUtterance>>);
    controller.previewProps.onEnrollmentFrame(id, frame());
  });
  expect(controller.busy).toBe(false);
  expect(controller.sheet).toBeNull();
  await view.rerender(<Harness />);
  expect(controller.previewProps.enrollment?.armed).toBe(true);
});
it('retains frames after an upload failure and retries only the failed upload', async () => {
  mockRecord.mockResolvedValue(false);
  jest.mocked(upload).mockRejectedValueOnce(new Error('offline'));
  await render(<Harness />);
  await begin(8);
  await fireEvent.press(screen.getByLabelText('Dừng chụp'));
  expect(screen.getByLabelText('Tải lại ảnh')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Tải lại ảnh'));
  expect(jest.mocked(upload)).toHaveBeenCalledTimes(9);
  expect(screen.queryByLabelText('Tải lại ảnh')).toBeNull();
  const props = jest.mocked(QuickEnrollSheet).mock.calls.at(-1)![0];
  expect(props.oneTrip!.frames.every((frame) => !!frame.imageId)).toBe(true);
});
it('starts the first capture after StrictMode replays mount effects', async () => {
  await render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  await begin(8);
  await fireEvent.press(screen.getByLabelText('Dừng chụp'));
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Tên và giá?')).toBeOnTheScreen();
});
