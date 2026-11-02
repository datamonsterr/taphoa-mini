import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { ImageManipulator } from 'expo-image-manipulator';
import { renderWithProviders } from '@/test/render';
import { visionMock } from '@/test/visionCamera';
import * as images from '@/lib/api/images';
import { setAnalyticsSink } from '@/lib/analytics';
import { CameraScreen } from './CameraScreen';
import { uploadPartsAsBlobs } from './testing';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useIsFocused: () => true,
}));
jest.mock('./useDocumentProbe', () => ({ useDocumentProbe: () => null }));

beforeEach(() => {
  AppState.currentState = 'active';
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
