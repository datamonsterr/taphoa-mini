import { createRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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

async function armEnrollment() {
  const view = await setup();
  const enrollment = { id: 42, armed: true, capturing: false };
  const onEnrollmentStart = jest.fn();
  const onEnrollmentFrame = jest.fn();
  const onEnrollmentTrack = jest.fn();
  const props = { ...view.props, autoIdentify: false, enrollment, onEnrollmentStart, onEnrollmentFrame, onEnrollmentTrack };
  await view.rerender(<CameraPreview {...props} />);
  await fireEvent(screen.getByTestId('camera-view'), 'layout', { nativeEvent: { layout: { width: 100, height: 200 } } });
  await act(() => visionMock.emit([{ trackingId: 7, x: 10, y: 20, width: 30, height: 40 }]));
  await fireEvent.press(screen.getByTestId('one-trip-lock'), { nativeEvent: { locationX: 20, locationY: 30 } });
  expect(onEnrollmentStart).toHaveBeenCalledTimes(1);
  await view.rerender(<CameraPreview {...props} enrollment={{ ...enrollment, armed: false, capturing: true }} />);
  return { ...view, onEnrollmentFrame, onEnrollmentTrack };
}
function sharpPixels(invert = false) {
  const pixels = new Uint8Array(160 * 160 * 3);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    const value = (Math.floor(x / 3) + Math.floor(y / 2) + Number(invert)) % 2 * 255;
    pixels.fill(value, (y * 160 + x) * 3, (y * 160 + x) * 3 + 3);
  }
  return pixels.buffer;
}
it('locks by one box tap, gates quality at 3.5fps, encodes upright full-frame JPEGs off the frame thread, and rejects unchanged views', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  visionMock.thumb.getPixelBuffer.mockReturnValue(sharpPixels());
  const resized = { ...visionMock.image, width: 1024, height: 768 };
  visionMock.image.resize.mockReturnValue(resized);
  const { onEnrollmentFrame } = await armEnrollment();
  // armEnrollment's reset is only in beforeEach; its first frame predates the lock.
  const objects = [{ trackingId: 7, x: 10, y: 20, width: 30, height: 40 }];
  now = 1285;
  await act(() => visionMock.emit(objects));
  await waitFor(() => expect(onEnrollmentFrame).toHaveBeenCalledTimes(1));
  expect(visionMock.asyncRunner.runAsync).toHaveBeenCalled();
  expect(visionMock.image.resize).toHaveBeenCalledWith(1024, 768);
  expect(onEnrollmentFrame).toHaveBeenCalledWith(42, { uri: 'file:///keyframe.jpg', width: 1024, height: 768,
    bbox: { x: 0.1, y: 0.1, width: expect.closeTo(0.3), height: expect.closeTo(0.2) } });
  expect(visionMock.thumb.dispose).toHaveBeenCalled();
  const tasks = visionMock.asyncRunner.runAsync.mock.calls.length;
  now += 100;
  await act(() => visionMock.emit(objects));
  expect(visionMock.asyncRunner.runAsync).toHaveBeenCalledTimes(tasks);
  now += 285;
  await act(() => visionMock.emit(objects));
  expect(onEnrollmentFrame).toHaveBeenCalledTimes(1);
  expect(visionMock.frame.dispose).toHaveBeenCalledTimes(4);
});
it('retains last-seen time through loss, reacquires an overlapping new id, and recovers after a resize exception', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const { onEnrollmentTrack } = await armEnrollment();
  now = 2200;
  await act(() => visionMock.emit([]));
  expect(onEnrollmentTrack).toHaveBeenLastCalledWith(42, 1000);
  now = 2500;
  visionMock.resizer.resize.mockImplementationOnce(() => { throw new Error('GPU unavailable'); });
  await act(() => visionMock.emit([{ trackingId: 9, x: 11, y: 20, width: 30, height: 40 }]));
  expect(onEnrollmentTrack).toHaveBeenLastCalledWith(42, 2500);
  expect(visionMock.frame.dispose).toHaveBeenCalledTimes(3);
  now = 2800;
  await act(() => visionMock.emit([{ trackingId: 9, x: 11, y: 20, width: 30, height: 40 }]));
  expect(onEnrollmentTrack).toHaveBeenLastCalledWith(42, 2800);
});
