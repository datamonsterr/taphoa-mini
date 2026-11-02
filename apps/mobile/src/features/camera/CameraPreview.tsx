// Metro resolves .native on devices; web/Jest can use the Expo preview.
export {
  CameraPreview,
  useCameraPermissions,
  supportsOneTripEnrollment,
} from './CameraPreview.web';
