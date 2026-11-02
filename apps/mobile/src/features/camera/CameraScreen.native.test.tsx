import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AppState, View } from 'react-native';
import { useReducer } from 'react';
import { ImageManipulator } from 'expo-image-manipulator';
import { renderWithProviders } from '@/test/render';
import { visionMock } from '@/test/visionCamera';
import * as images from '@/lib/api/images';
import * as receipts from '@/lib/api/receipts';
import { setAnalyticsSink } from '@/lib/analytics';
import { useSettingsStore } from '@/stores/settings';
import { CameraScreen } from './CameraScreen';
import { uploadPartsAsBlobs } from './testing';
import type { CameraPreviewProps } from './CameraPreview.types';
import type { useOneTripEnrollment } from './useOneTripEnrollment';

let mockPreviewProps: CameraPreviewProps;
let mockFocused = true;
let mockDocumentDetected = false;
let mockEnrollmentGate:
  Partial<ReturnType<typeof useOneTripEnrollment>> | undefined;

jest.mock('./CameraPreview', () => {
  const actual = jest.requireActual('./CameraPreview.native');
  return {
    ...actual,
    supportsOneTripEnrollment: true,
    CameraPreview: (props: CameraPreviewProps) => {
      mockPreviewProps = props;
      return <actual.CameraPreview {...props} />;
    },
  };
});
jest.mock('./useOneTripEnrollment', () => {
  const actual = jest.requireActual('./useOneTripEnrollment');
  return {
    useOneTripEnrollment: (
      ...args: Parameters<typeof useOneTripEnrollment>
    ) => ({
      ...actual.useOneTripEnrollment(...args),
      ...mockEnrollmentGate,
    }),
  };
});

jest.mock('./vision/nativeAvailable', () => ({
  isVisionNativeAvailable: () => true,
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useIsFocused: () => mockFocused,
}));
jest.mock('./useDocumentProbe', () => ({
  useDocumentProbe: (_ref: unknown, enabled: boolean) =>
    enabled && mockDocumentDetected
      ? {
          document: {
            detected: true,
            score: 0.9,
            text_lines: 12,
            line_boxes: [],
          },
          imageSize: { width: 100, height: 200 },
          previewMirrored: false,
        }
      : null,
}));

beforeEach(() => {
  AppState.currentState = 'active';
  mockFocused = true;
  mockDocumentDetected = false;
  mockEnrollmentGate = undefined;
  visionMock.reset();
  mockPush.mockClear();
  uploadPartsAsBlobs();
  jest.spyOn(ImageManipulator, 'manipulate').mockImplementation(
    () =>
      ({
        renderAsync: async () => ({
          saveAsync: async () => ({
            uri: 'file:///upright.jpg',
            width: 640,
            height: 1280,
          }),
        }),
      }) as unknown as ReturnType<typeof ImageManipulator.manipulate>,
  );
});
afterEach(() => {
  setAnalyticsSink(null);
  jest.restoreAllMocks();
});
it('sends current native tracked boxes on shutter and freezes the returned photo', async () => {
  const create = jest.spyOn(images, 'createScan');
  await renderWithProviders(<CameraScreen />);
  await act(() =>
    visionMock.emit([{ trackingId: 8, x: 10, y: 20, width: 30, height: 40 }]),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]![0]).toMatchObject({
    boxes: [
      {
        x: 0.1,
        y: 0.1,
        width: expect.closeTo(0.3),
        height: expect.closeTo(0.2),
        track_id: 8,
      },
    ],
  });
  await screen.findByRole('button', { name: 'Chụp lại' });
  expect(screen.getByTestId('viewfinder-photo')).toBeOnTheScreen();
  expect(visionMock.mounts).toBe(1);
});
it('auto identifies once for a stable set and records the auto trigger', async () => {
  const capture = jest.fn();
  setAnalyticsSink({ capture });
  const create = jest.spyOn(images, 'createScan');
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  await renderWithProviders(<CameraScreen />);
  const boxes = [{ trackingId: 8, x: 10, y: 20, width: 30, height: 40 }];
  for (const time of [1000, 1350, 1700]) {
    now = time;
    await act(() => visionMock.emit(boxes));
  }
  await screen.findByRole('button', { name: 'Chụp lại' });
  expect(create).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith('scan_result_received', {
    trigger: 'auto',
    latency_ms: expect.any(Number),
  });
  await act(() => visionMock.emit(boxes));
  expect(create).toHaveBeenCalledTimes(1);
});
it('native Code mode filters non-digit QR content and routes unknown numeric codes to enrollment', async () => {
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Mã vạch/QR' }));
  const emit = async (rawValue: string) =>
    act(() =>
      visionMock.barcodeOptions.onBarcodeScanned([
        { rawValue, format: 'qr-code' } as Parameters<
          typeof visionMock.barcodeOptions.onBarcodeScanned
        >[0][number],
      ]),
    );
  await emit('https://example.com');
  expect(mockPush).not.toHaveBeenCalled();
  await emit('123456789');
  await waitFor(() =>
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/enroll',
      params: { barcode: '123456789' },
    }),
  );
  expect(screen.getByTestId('barcode-indicator')).toBeOnTheScreen();
  expect(visionMock.mounts).toBe(1);
});

it('restores a manual shutter after an automatic result when Auto identify is switched off', async () => {
  const create = jest.spyOn(images, 'createScan');
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  await renderWithProviders(<CameraScreen />);
  const emitStable = async (trackingId: number) => {
    for (let frame = 0; frame < 3; frame++) {
      now += 350;
      await act(() =>
        visionMock.emit([{ trackingId, x: 10, y: 20, width: 30, height: 40 }]),
      );
    }
  };
  await emitStable(8);
  await screen.findByRole('button', { name: 'Chụp lại' });
  expect(create).toHaveBeenCalledTimes(1);
  await act(() => useSettingsStore.getState().setAutoIdentify(false));
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp lại' }));
  await emitStable(9);
  expect(screen.getByRole('button', { name: 'Chụp' })).toBeEnabled();
  expect(create).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
});

describe('automatic identify exclusions, including callbacks queued before a gate changes', () => {
  let refresh!: () => void;
  function GateHarness() {
    const [, update] = useReducer((n: number) => n + 1, 0);
    refresh = update;
    return <CameraScreen />;
  }
  async function renderGate() {
    await renderWithProviders(<GateHarness />);
    return { rerender: () => act(() => refresh()) };
  }
  async function assertBlocked(queued: () => void, create: jest.SpyInstance) {
    expect(mockPreviewProps.autoIdentify).toBe(false);
    await act(() => queued());
    expect(create).not.toHaveBeenCalled();
  }

  it('blocks when the live document probe detects a receipt', async () => {
    const create = jest.spyOn(images, 'createScan');
    const { rerender } = await renderGate();
    const queued = mockPreviewProps.onAutoCapture;
    mockDocumentDetected = true;
    await rerender();
    expect(screen.getByText('Hóa đơn · 12 dòng chữ')).toBeOnTheScreen();
    await assertBlocked(queued, create);
  });

  it('blocks while a receipt is being read in its modal', async () => {
    const create = jest.spyOn(images, 'createScan');
    let finish!: (
      value: Awaited<ReturnType<typeof receipts.createReceipt>>,
    ) => void;
    const reading = jest.spyOn(receipts, 'createReceipt').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = await renderGate();
    const queued = mockPreviewProps.onAutoCapture;
    mockDocumentDetected = true;
    await rerender();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Đọc hóa đơn nhập' }),
    );
    await waitFor(() => expect(reading).toHaveBeenCalled());
    await assertBlocked(queued, create);
    await act(() =>
      finish({ id: 'receipt-gate' } as Awaited<
        ReturnType<typeof receipts.createReceipt>
      >),
    );
  });

  it('blocks in Code mode', async () => {
    const create = jest.spyOn(images, 'createScan');
    await renderWithProviders(<CameraScreen />);
    const queued = mockPreviewProps.onAutoCapture;
    await fireEvent.press(screen.getByRole('button', { name: 'Mã vạch/QR' }));
    await assertBlocked(queued, create);
  });

  it.each(['armed', 'capturing'] as const)(
    'blocks while one-trip enrollment is %s',
    async (phase) => {
      const create = jest.spyOn(images, 'createScan');
      await renderWithProviders(<CameraScreen />);
      const queued = mockPreviewProps.onAutoCapture;
      await fireEvent.press(
        screen.getByRole('button', { name: 'Thêm vào kho với giá' }),
      );
      if (phase === 'capturing')
        await act(() => mockPreviewProps.onEnrollmentStart?.());
      expect(mockPreviewProps.enrollment?.[phase]).toBe(true);
      await assertBlocked(queued, create);
    },
  );

  it.each(['sheet', 'modal'] as const)(
    'blocks while an enrollment %s remains open',
    async (kind) => {
      const create = jest.spyOn(images, 'createScan');
      const { rerender } = await renderGate();
      const queued = mockPreviewProps.onAutoCapture;
      // A close/cancel may leave the overlay mounted until the enrollment effect clears it.
      mockEnrollmentGate = {
        sheet: (
          <View
            testID="enrollment-overlay"
            accessibilityViewIsModal={kind === 'modal'}
          />
        ),
      };
      await rerender();
      expect(screen.getByTestId('enrollment-overlay')).toBeOnTheScreen();
      await assertBlocked(queued, create);
    },
  );

  it('blocks when a routed sheet or modal takes focus', async () => {
    const create = jest.spyOn(images, 'createScan');
    const { rerender } = await renderGate();
    const queued = mockPreviewProps.onAutoCapture;
    mockFocused = false;
    await rerender();
    await assertBlocked(queued, create);
  });
});
