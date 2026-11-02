import type { RefObject } from 'react';
import type { PictureTaker } from './capture';

export type CameraPreviewProps = {
  cameraRef: RefObject<PictureTaker | null>;
  active: boolean;
  codeMode: boolean;
  detectionEnabled: boolean;
  autoIdentify: boolean;
  onAutoCapture: () => void;
  onReadyChange: (ready: boolean) => void;
  onBarcodeScanned?: (result: { data: string; type: string }) => void;
};
