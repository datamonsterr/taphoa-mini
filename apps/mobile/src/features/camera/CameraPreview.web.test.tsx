import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { CameraPreview } from './CameraPreview.web';
import type { PictureTaker } from './capture';
import { CODE_SETTINGS } from './barcode';

it('renders the Expo webcam preview and retains the capture and barcode contract', async () => {
  const cameraRef = createRef<PictureTaker>();
  const onBarcodeScanned = jest.fn();
  const props = {
    cameraRef,
    active: true,
    codeMode: false,
    detectionEnabled: true,
    autoIdentify: true,
    onAutoCapture: jest.fn(),
    onReadyChange: jest.fn(),
    onBarcodeScanned,
  };
  const { rerender } = await render(<CameraPreview {...props} />);
  expect(screen.queryByTestId('vision-camera')).toBeNull();
  const preview = screen.getByTestId('camera-view');
  expect(preview.props.barcodeScannerSettings).toEqual(CODE_SETTINGS);
  expect(preview.props.onBarcodeScanned).toBeUndefined();
  expect(props.onReadyChange).toHaveBeenCalledWith(true);
  await expect(cameraRef.current!.takePictureAsync({})).resolves.toMatchObject({
    uri: 'file:///mock.jpg',
  });
  await rerender(<CameraPreview {...props} codeMode />);
  await act(() =>
    screen.getByTestId('camera-view').props.onBarcodeScanned({
      data: '12345678',
      type: 'ean8',
    }),
  );
  expect(onBarcodeScanned).toHaveBeenCalledWith({
    data: '12345678',
    type: 'ean8',
  });
  expect(props.onAutoCapture).not.toHaveBeenCalled();
  await rerender(<CameraPreview {...props} active={false} />);
  expect(screen.queryByTestId('camera-view')).toBeNull();
  expect(props.onReadyChange).toHaveBeenLastCalledWith(false);
});
