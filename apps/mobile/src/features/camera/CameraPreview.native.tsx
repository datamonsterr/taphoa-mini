/* eslint-disable @typescript-eslint/no-require-imports -- Native modules must be loaded conditionally. */
import * as expoPreview from './CameraPreview.web';
import { isVisionNativeAvailable } from './vision/nativeAvailable';

// Keep Vision Camera out of route evaluation when its native hybrid objects are absent.
const preview = isVisionNativeAvailable()
  ? (require('./VisionCameraPreview') as typeof import('./VisionCameraPreview'))
  : expoPreview;

export const CameraPreview = preview.CameraPreview;
export const useCameraPermissions = preview.useCameraPermissions;
export const supportsOneTripEnrollment = preview.supportsOneTripEnrollment;
