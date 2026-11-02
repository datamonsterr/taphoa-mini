import type { ObjectDetector } from './ObjectDetector.nitro';

/** iOS/web have no native detector yet. No Nitro runtime imports in this fallback. */
export function createObjectDetector(): ObjectDetector | null {
  return null;
}
