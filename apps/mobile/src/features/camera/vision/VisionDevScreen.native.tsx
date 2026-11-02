/* eslint-disable @typescript-eslint/no-require-imports -- Native modules must be loaded conditionally. */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import Fallback from './VisionDevFallback';

// Router evaluates route modules even before this screen is opened.
const VisionDevScreen =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient
    ? Fallback
    : (
        require('./NativeVisionDevScreen') as typeof import('./NativeVisionDevScreen')
      ).default;

export default VisionDevScreen;
