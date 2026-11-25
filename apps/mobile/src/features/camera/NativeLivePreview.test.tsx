/* eslint-disable @typescript-eslint/no-require-imports -- Jest mock factories run before imports. */
import { act, render, waitFor } from '@testing-library/react-native';
import { useRef } from 'react';
import { NativeLivePreview } from './NativeLivePreview';
import { useBarcodeScanner } from './useBarcodeScanner';
import type { PictureTaker } from './capture';

const mockFrame = { dispose: jest.fn() };
let mockOnFrame: (frame: typeof mockFrame) => void;
const mockScan = jest.fn(() => ({
  barcodes: [{ rawValue: '4006381333931', formatName: 'EAN_13' }],
}));
const mockText = jest.fn(() => ({ text: '' }));
jest.mock('react-native-vision-camera', () => {
  const { View } = require('react-native');
  const output = { dispose: jest.fn() };
  return {
    Camera: View,
    usePhotoOutput: () => output,
    useFrameOutput: ({ onFrame }: { onFrame: typeof mockOnFrame }) => {
      mockOnFrame = onFrame;
      return output;
    },
  };
});
jest.mock('react-native-vision-camera-mlkit', () => ({
  useBarcodeScanning: () => ({ barcodeScanning: mockScan }),
  useTextRecognition: () => ({ textRecognition: mockText }),
}));
jest.mock('react-native-worklets', () => ({
  createSynchronizable: () => {
    let value = 0;
    return {
      getBlocking: () => value,
      setBlocking: (next: number) => {
        value = next;
      },
    };
  },
  scheduleOnRN: (fn: (...args: string[]) => void, ...args: string[]) =>
    fn(...args),
}));
const lookup = jest.fn().mockResolvedValue({ id: 'known' });
const onResult = jest.fn();
function Harness({ codeMode = true }: { codeMode?: boolean }) {
  const ref = useRef<PictureTaker>(null);
  const scanningRef = useRef(true);
  const scanner = useBarcodeScanner({
    enabled: true,
    lookup,
    onResult,
    onError: jest.fn(),
  });
  return (
    <NativeLivePreview
      codeMode={codeMode}
      cameraRef={ref}
      scanningRef={scanningRef}
      onBarcodeScanned={scanner.scan}
      onReadyChange={jest.fn()}
    />
  );
}

test('ML Kit barcode reaches lookup and releases the frame', async () => {
  await render(<Harness />);
  await act(async () => mockOnFrame(mockFrame));
  await waitFor(() => expect(lookup).toHaveBeenCalledWith('4006381333931'));
  expect(onResult).toHaveBeenCalledWith('4006381333931', { id: 'known' });
  expect(mockFrame.dispose).toHaveBeenCalledTimes(1);
});

test('ML Kit numeric text reaches the same lookup', async () => {
  lookup.mockClear();
  onResult.mockClear();
  mockScan.mockReturnValueOnce({ barcodes: [] });
  mockText.mockReturnValueOnce({ text: 'EAN 8931234567890' });
  await render(<Harness />);
  await act(async () => mockOnFrame(mockFrame));
  await waitFor(() => expect(lookup).toHaveBeenCalledWith('8931234567890'));
  expect(onResult).toHaveBeenCalledWith('8931234567890', { id: 'known' });
});

test('does not process frames outside code mode', async () => {
  mockScan.mockClear();
  mockText.mockClear();
  await render(<Harness codeMode={false} />);
  await act(async () => mockOnFrame(mockFrame));
  expect(mockScan).not.toHaveBeenCalled();
  expect(mockText).not.toHaveBeenCalled();
  expect(mockFrame.dispose).toHaveBeenCalled();
});
