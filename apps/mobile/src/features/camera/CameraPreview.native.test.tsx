import { createRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { ImageManipulator } from 'expo-image-manipulator';
import { CameraPreview } from './CameraPreview.native';
import { takeProbePhoto, type PictureTaker } from './capture';
import { visionMock } from '@/test/visionCamera';

afterEach(() => jest.restoreAllMocks());
beforeEach(() => {
  AppState.currentState = 'active';
  visionMock.reset();
});
const setup = async () => {
  const cameraRef = createRef<PictureTaker>();
  const props = {
    cameraRef,
    active: true,
    codeMode: false,
    detectionEnabled: true,
    autoIdentify: true,
    onAutoCapture: jest.fn(),
    onReadyChange: jest.fn(),
    onBarcodeScanned: jest.fn(),
  };
  const view = await render(<CameraPreview {...props} />);
  return { ...view, props, cameraRef };
};
it('keeps the camera mounted while switching the object and code outputs', async () => {
  const { rerender, props } = await setup();
  const original = screen.getByTestId('vision-camera');
  expect(original.props.outputs).toContain(visionMock.frameOutput);
  await rerender(<CameraPreview {...props} codeMode />);
  expect(screen.getByTestId('vision-camera')).toBe(original);
  expect(visionMock.mounts).toBe(1);
  expect(screen.getByTestId('vision-camera').props.outputs).toContain(
    visionMock.barcodeOutput,
  );
  expect(screen.getByTestId('vision-camera').props.outputs).not.toContain(
    visionMock.frameOutput,
  );
  expect(visionMock.barcodeOptions.barcodeFormats).toEqual([
    'ean-13',
    'ean-8',
    'upc-a',
    'upc-e',
    'code-128',
    'qr-code',
  ]);
  await act(() =>
    visionMock.barcodeOptions.onBarcodeScanned([
      { rawValue: '12345678', format: 'ean-8' } as Parameters<
        typeof visionMock.barcodeOptions.onBarcodeScanned
      >[0][number],
    ]),
  );
  expect(props.onBarcodeScanned).toHaveBeenCalledWith({
    data: '12345678',
    type: 'ean-8',
  });
});
it('runs YUV frames with a fallback id, snapshots boxes for a JPEG upload, and releases outputs', async () => {
  const { cameraRef, unmount } = await setup();
  expect(visionMock.frameOptions).toMatchObject({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
  });
  await act(() =>
    visionMock.emit([
      { trackingId: null, x: 10, y: 20, width: 30, height: 40 },
    ]),
  );
  const manipulate = jest
    .spyOn(ImageManipulator, 'manipulate')
    .mockImplementation(
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
  const photo = await cameraRef.current!.takePictureAsync({});
  expect(photo!.boxes).toEqual([
    {
      x: 0.1,
      y: 0.1,
      width: expect.closeTo(0.3),
      height: expect.closeTo(0.2),
      track_id: -1,
    },
  ]);
  expect(manipulate).toHaveBeenCalledWith('file:///vision.jpg', {
    maxWidth: 1280,
    maxHeight: 1280,
  });
  expect(visionMock.frame.dispose).toHaveBeenCalled();
  await unmount();
  expect(visionMock.frameOutput.dispose).toHaveBeenCalled();
  expect(visionMock.photoOutput.dispose).toHaveBeenCalled();
  expect(visionMock.detector.dispose).toHaveBeenCalled();
});
it('recovers from detector errors, discards stale boxes, and does not trigger auto while frozen', async () => {
  const { cameraRef, props, rerender } = await setup();
  await act(() =>
    visionMock.emit([{ trackingId: 1, x: 10, y: 20, width: 30, height: 40 }]),
  );
  visionMock.detector.detectObjects.mockImplementationOnce(() => {
    throw new Error('bad frame');
  });
  await act(() => visionMock.emit([]));
  expect(visionMock.frame.dispose).toHaveBeenCalledTimes(2);
  expect((await cameraRef.current!.takePictureAsync({}))!.boxes).toEqual([]);
  await rerender(<CameraPreview {...props} detectionEnabled={false} />);
  await act(() => visionMock.emit([]));
  expect(props.onAutoCapture).not.toHaveBeenCalled();
});

it('auto captures once at 700ms without per-frame React renders and blocks frozen/background work', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const { props, rerender } = await setup();
  const renders = visionMock.renders;
  const objects = [{ trackingId: 9, x: 10, y: 20, width: 30, height: 40 }];
  for (const time of [1000, 1350, 1699]) {
    now = time;
    await act(() => visionMock.emit(objects));
  }
  expect(props.onAutoCapture).not.toHaveBeenCalled();
  now = 1700;
  await act(() => visionMock.emit(objects));
  expect(props.onAutoCapture).toHaveBeenCalledTimes(1);
  now = 2050;
  await act(() => visionMock.emit(objects));
  expect(visionMock.renders).toBe(renders);
  await rerender(<CameraPreview {...props} detectionEnabled={false} />);
  // A shutter must not reconfigure CameraX while its still capture is pending.
  expect(screen.getByTestId('vision-camera').props.outputs).toContain(
    visionMock.frameOutput,
  );
  await act(() => visionMock.emit(objects));
  expect(props.onAutoCapture).toHaveBeenCalledTimes(1);
  await rerender(<CameraPreview {...props} active={false} />);
  expect(screen.getByTestId('vision-camera').props.isActive).toBe(false);
  expect(visionMock.mounts).toBe(1);
});

it('ignores a queued barcode callback after the app backgrounds', async () => {
  let change!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    change = listener;
    return { remove: jest.fn() };
  });
  const { props, rerender } = await setup();
  await rerender(<CameraPreview {...props} codeMode />);
  await act(() => change('background'));
  await act(() =>
    visionMock.barcodeOptions.onBarcodeScanned([
      { rawValue: '12345678', format: 'ean-8' } as Parameters<
        typeof visionMock.barcodeOptions.onBarcodeScanned
      >[0][number],
    ]),
  );
  expect(props.onBarcodeScanned).not.toHaveBeenCalled();
  expect(screen.getByTestId('vision-camera').props.isActive).toBe(false);
});

it('supports the silent receipt probe through the native capture adapter', async () => {
  const { cameraRef } = await setup();
  const saveAsync = jest.fn(async () => ({
    uri: 'file:///probe.jpg',
    width: 320,
    height: 640,
  }));
  const manipulate = jest
    .spyOn(ImageManipulator, 'manipulate')
    .mockReturnValue({
      renderAsync: async () => ({ saveAsync }),
    } as unknown as ReturnType<typeof ImageManipulator.manipulate>);
  const photo = await takeProbePhoto(cameraRef.current);
  expect(visionMock.photoOutput.capturePhotoToFile).toHaveBeenCalledWith(
    { flashMode: 'off', enableShutterSound: false },
    {},
  );
  expect(manipulate).toHaveBeenLastCalledWith('file:///probe.jpg', {
    maxWidth: 640,
    maxHeight: 640,
  });
  expect(photo).toMatchObject({
    width: 320,
    height: 640,
    previewMirrored: false,
  });
});
