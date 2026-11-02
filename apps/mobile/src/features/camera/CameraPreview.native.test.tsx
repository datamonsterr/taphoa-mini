import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { ImageManipulator } from 'expo-image-manipulator';
import { CameraPreview } from './CameraPreview.native';
import type { PictureTaker } from './capture';
import { visionMock } from '@/test/visionCamera';

beforeEach(() => visionMock.reset());
const setup = () => {
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
  const view = render(<CameraPreview {...props} />);
  return { ...view, props, cameraRef };
};
it('keeps the camera mounted while switching the object and code outputs', () => {
  const { rerender, props } = setup();
  const original = screen.getByTestId('camera-view');
  expect(original.props.outputs).toContain(visionMock.frameOutput);
  rerender(<CameraPreview {...props} codeMode />);
  expect(screen.getByTestId('camera-view')).toBe(original);
  expect(visionMock.mounts).toBe(1);
  expect(screen.getByTestId('camera-view').props.outputs).toContain(
    visionMock.barcodeOutput,
  );
  expect(screen.getByTestId('camera-view').props.outputs).not.toContain(
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
  act(() =>
    visionMock.barcodeOptions.onBarcodeScanned([
      { rawValue: '12345678', format: 'ean-8' },
    ]),
  );
  expect(props.onBarcodeScanned).toHaveBeenCalledWith({
    data: '12345678',
    type: 'ean-8',
  });
});
it('runs YUV frames with a fallback id, snapshots boxes for a JPEG upload, and releases outputs', async () => {
  const { cameraRef, unmount } = setup();
  expect(visionMock.frameOptions).toMatchObject({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
  });
  act(() =>
    visionMock.emit([
      { trackingId: null, x: 10, y: 20, width: 30, height: 40 },
    ]),
  );
  const manipulate = jest.spyOn(ImageManipulator, 'manipulate');
  const photo = await cameraRef.current!.takePictureAsync({});
  expect(photo!.boxes).toEqual([
    { x: 0.1, y: 0.1, width: 0.3, height: 0.2, track_id: -1 },
  ]);
  expect(manipulate).toHaveBeenCalledWith('file:///vision.jpg', {
    maxWidth: 1280,
    maxHeight: 1280,
  });
  expect(visionMock.frame.dispose).toHaveBeenCalled();
  unmount();
  expect(visionMock.frameOutput.dispose).toHaveBeenCalled();
  expect(visionMock.photoOutput.dispose).toHaveBeenCalled();
  expect(visionMock.detector.dispose).toHaveBeenCalled();
});
it('recovers from detector errors, discards stale boxes, and does not trigger auto while frozen', async () => {
  const { cameraRef, props, rerender } = setup();
  act(() =>
    visionMock.emit([{ trackingId: 1, x: 10, y: 20, width: 30, height: 40 }]),
  );
  visionMock.detector.detectObjects.mockImplementationOnce(() => {
    throw new Error('bad frame');
  });
  act(() => visionMock.emit([]));
  expect(visionMock.frame.dispose).toHaveBeenCalledTimes(2);
  expect((await cameraRef.current!.takePictureAsync({}))!.boxes).toEqual([]);
  rerender(<CameraPreview {...props} detectionEnabled={false} />);
  act(() => visionMock.emit([]));
  expect(props.onAutoCapture).not.toHaveBeenCalled();
});
