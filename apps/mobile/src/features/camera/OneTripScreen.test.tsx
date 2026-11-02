import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { CameraPreviewProps } from './CameraPreview.types';
import { renderWithProviders } from '@/test/render';
import { setApiTransport } from '@/lib/api';
import { createMockFetch, resetMockDb } from '@/test/mock';
import { setAnalyticsSink } from '@/lib/analytics';
import { uploadUtterance } from '@/features/voice/api';
import { CameraScreen } from './CameraScreen';
import { initialQuickEnroll, useQuickEnrollStore } from './quickEnroll';
import { uploadPartsAsBlobs } from './testing';

let mockFinished: (clip: unknown) => void;
const mockStart = jest.fn(async () => true);
const mockCancel = jest.fn(async () => {});
jest.mock('@/features/voice/useVoiceRecorder', () => ({
  useVoiceRecorder: (options: { onFinished: typeof mockFinished }) => {
    mockFinished = options.onFinished;
    return {
      start: mockStart,
      cancel: mockCancel,
      status: 'recording',
      available: true,
      stop: async () =>
        mockFinished({ uri: 'file:///voice.m4a', durationMs: 1000 }),
    };
  },
}));
jest.mock('@/features/voice/api', () => ({ uploadUtterance: jest.fn() }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useIsFocused: () => true,
}));
jest.mock('./useDocumentProbe', () => ({ useDocumentProbe: () => null }));
jest.mock('./CameraPreview', () => {
  const { View, Pressable } = jest.requireActual('react-native');
  return {
    supportsOneTripEnrollment: true,
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
    CameraPreview: (props: CameraPreviewProps) => (
      <View>
        <Pressable
          testID="lock-enroll-box"
          onPress={() => props.onEnrollmentStart?.()}
        />
        <Pressable
          testID="keep-keyframe"
          onPress={() =>
            props.onEnrollmentFrame?.(props.enrollment!.id, {
              uri: 'file:///keyframe.jpg',
              width: 768,
              height: 1024,
              bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
            })
          }
        />
        <Pressable
          testID="track-missing"
          onPress={() =>
            props.onEnrollmentTrack?.(props.enrollment!.id, Date.now() - 1001)
          }
        />
        <Pressable
          testID="track-returned"
          onPress={() =>
            props.onEnrollmentTrack?.(props.enrollment!.id, Date.now())
          }
        />
      </View>
    ),
  };
});

beforeEach(() => {
  resetMockDb();
  setApiTransport(createMockFetch());
  useQuickEnrollStore.setState(initialQuickEnroll);
  uploadPartsAsBlobs();
  mockStart.mockClear();
  jest.mocked(uploadUtterance).mockResolvedValue({
    product_draft: { name: 'Mì gói', price: 5000, unit: 'gói' },
  } as Awaited<ReturnType<typeof uploadUtterance>>);
});
afterEach(() => {
  setAnalyticsSink(null);
  jest.restoreAllMocks();
});
async function captureEight() {
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByLabelText('Thêm vào kho với giá'));
  await fireEvent.press(screen.getByTestId('lock-enroll-box'));
  for (let i = 0; i < 8; i++)
    await fireEvent.press(screen.getByTestId('keep-keyframe'));
  await fireEvent.press(screen.getByLabelText('Dừng chụp'));
  await screen.findByText('Tên và giá?');
}
it('tap box -> eight keyframes -> voice prefill -> one save with keyframe references and C1 telemetry', async () => {
  const requests: Record<string, unknown>[] = [];
  const transport = createMockFetch();
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/v1/products'
    )
      requests.push(await request.clone().json());
    return transport(request);
  });
  const analytics = jest.fn();
  setAnalyticsSink({ capture: analytics });
  await captureEight();
  expect(mockStart).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText('Xong'));
  await screen.findByDisplayValue('Mì gói');
  expect(screen.getByText('5.000đ')).toBeOnTheScreen();
  expect(screen.getByDisplayValue('gói')).toBeOnTheScreen();
  expect(uploadUtterance).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'product', screen: 'camera' }),
  );
  await fireEvent.press(screen.getByLabelText('Lưu sản phẩm'));
  await screen.findByText('Đã thêm Mì gói');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    name: 'Mì gói',
    price: 5000,
    base_unit: 'gói',
    references: Array.from({ length: 8 }, () => ({
      image_id: expect.any(String),
      source: 'keyframe',
      bbox: [expect.closeTo(76.8), 204.8, 384, 409.6],
    })),
  });
  expect(analytics).toHaveBeenCalledWith('one_trip_enrollment_completed', {
    duration_ms: expect.any(Number),
    keyframe_count: 8,
    voice_success: true,
  });
  expect(screen.queryByTestId('point-overlay-canvas')).toBeNull();
});
it('pauses the coverage ring after a second without the track, then resumes on reacquisition', async () => {
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByLabelText('Thêm vào kho với giá'));
  await fireEvent.press(screen.getByTestId('lock-enroll-box'));
  await fireEvent.press(screen.getByTestId('track-missing'));
  await waitFor(() =>
    expect(screen.getByText('Giữ sản phẩm trong khung')).toBeOnTheScreen(),
  );
  expect(
    screen.getByTestId('coverage-ring').props.accessibilityState,
  ).toMatchObject({ busy: false });
  await fireEvent.press(screen.getByTestId('track-returned'));
  await waitFor(() =>
    expect(screen.queryByText('Giữ sản phẩm trong khung')).toBeNull(),
  );
});
it('voice failure opens an empty editable sheet with keyboard focus', async () => {
  jest.mocked(uploadUtterance).mockRejectedValueOnce(new Error('offline'));
  await captureEight();
  await fireEvent.press(screen.getByLabelText('Xong'));
  await screen.findByTestId('one-trip-enroll-sheet');
  expect(screen.getByLabelText('Tên (không bắt buộc)')).toHaveProp(
    'autoFocus',
    true,
  );
  expect(screen.getByLabelText('Tên (không bắt buộc)')).toHaveProp('value', '');
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Hàng mới',
  );
  expect(screen.getByDisplayValue('Hàng mới')).toBeOnTheScreen();
});
