import type { HybridObject } from 'react-native-nitro-modules';
import type { Frame } from 'react-native-vision-camera';

export interface DetectedObject {
  trackingId: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameMetadata {
  width: number;
  height: number;
  /** Clockwise rotation from buffer pixels to the output orientation, in degrees. */
  rotation: number;
  orientation: string;
  isMirrored: boolean;
}

export interface ObjectDetector extends HybridObject<{ android: 'kotlin' }> {
  /** Synchronous on the frame worklet thread. Caller owns/disposes the frame. */
  detectObjects(frame: Frame): DetectedObject[];
  getFrameMetadata(frame: Frame): FrameMetadata;
}
