import { NitroModules } from 'react-native-nitro-modules';
import type { ObjectDetector } from './ObjectDetector.nitro';

/** Capture this HybridObject in a worklet; dispose after stopping the frame output. */
export function createObjectDetector(): ObjectDetector {
  return NitroModules.createHybridObject<ObjectDetector>('ObjectDetector');
}
