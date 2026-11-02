/* eslint-disable @typescript-eslint/no-require-imports -- Native modules must be loaded conditionally. */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as expoPreview from './CameraPreview.web';

// Expo Go does not contain Vision Camera's Nitro native modules. Do not evaluate
// the Vision Camera module at all in the store client, including during routing.
const preview =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient
    ? expoPreview
    : (require('./VisionCameraPreview') as typeof import('./VisionCameraPreview'));

export const CameraPreview = preview.CameraPreview;
export const useCameraPermissions = preview.useCameraPermissions;
export const supportsOneTripEnrollment = preview.supportsOneTripEnrollment;
