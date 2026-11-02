/* eslint-disable @typescript-eslint/no-require-imports -- Native modules must be loaded conditionally. */
import Fallback from './VisionDevFallback';
import { isVisionNativeAvailable } from './nativeAvailable';

// Router evaluates route modules even before this screen is opened.
const VisionDevScreen = isVisionNativeAvailable()
  ? (
      require('./NativeVisionDevScreen') as typeof import('./NativeVisionDevScreen')
    ).default
  : Fallback;

export default VisionDevScreen;
