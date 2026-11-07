import type { RefObject } from 'react';
import type { PictureTaker } from './capture';
import type { EnrollmentControl, Keyframe } from './vision/enrollment';

export type CameraPreviewProps = {
  cameraRef: RefObject<PictureTaker | null>;
  active: boolean;
  codeMode: boolean;
  detectionEnabled: boolean;
  autoIdentify: boolean;
  onAutoCapture: () => void;
  onReadyChange: (ready: boolean) => void;
  onBarcodeScanned?: (result: { data: string; type: string }) => void;
  enrollment?: EnrollmentControl;
  onEnrollmentStart?: () => void;
  onEnrollmentFrame?: (id: number, frame: Keyframe) => void;
  onEnrollmentTrack?: (id: number, lastSeen: number) => void;
};
