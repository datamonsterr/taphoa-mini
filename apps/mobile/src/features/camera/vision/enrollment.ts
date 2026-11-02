import type { VoiceUtterance } from '@taphoa/api-client';
import type { Box } from './geometry';
import { intersectionOverUnion, type TrackedBox } from './tracker';

export const MIN_KEYFRAMES = 8;
export const MAX_KEYFRAMES = 24;
export const EVALUATE_MS = 285; // ~3.5 fps, independent of the detector rate.
export const THUMB_SIZE = 16;
/** Initial 8-bit luma floor. Calibrate on mid-range Android blur/sharp pairs before V1. */
export const SHARPNESS_FLOOR = 100;
export const VIEW_MAD_FLOOR = 12;
export type KeyframeSample = { box: Box; luma: number[] };
/** Bbox is normalized in the upright full-frame image, exactly like identify. */
export type Keyframe = {
  uri: string;
  width: number;
  height: number;
  bbox: Box;
  imageId?: string;
  error?: boolean;
};
export type EnrollmentControl = {
  id: number;
  armed: boolean;
  capturing: boolean;
};

/** The resizer supplies an upright RGB thumbnail of the whole frame, stretched without cropping. */
export function boxLumaThumbnail(
  pixels: Uint8Array,
  width: number,
  height: number,
  box: Box,
): number[] {
  'worklet';
  const result: number[] = [];
  for (let y = 0; y < THUMB_SIZE; y++) {
    for (let x = 0; x < THUMB_SIZE; x++) {
      const px = Math.max(
        0,
        Math.min(
          width - 1,
          Math.floor((box.x + ((x + 0.5) / THUMB_SIZE) * box.width) * width),
        ),
      );
      const py = Math.max(
        0,
        Math.min(
          height - 1,
          Math.floor((box.y + ((y + 0.5) / THUMB_SIZE) * box.height) * height),
        ),
      );
      const i = (py * width + px) * 3;
      result.push(
        0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2],
      );
    }
  }
  return result;
}
export function laplacianVariance(luma: readonly number[]): number {
  'worklet';
  if (luma.length !== THUMB_SIZE ** 2 || !luma.every(Number.isFinite)) return 0;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < THUMB_SIZE - 1; y++) {
    for (let x = 1; x < THUMB_SIZE - 1; x++) {
      const i = y * THUMB_SIZE + x;
      const lap =
        luma[i - 1] +
        luma[i + 1] +
        luma[i - THUMB_SIZE] +
        luma[i + THUMB_SIZE] -
        4 * luma[i];
      sum += lap;
      squares += lap * lap;
      count++;
    }
  }
  return Math.max(0, squares / count - (sum / count) ** 2);
}
export function viewChanged(
  current: KeyframeSample,
  last: KeyframeSample,
): boolean {
  'worklet';
  if (intersectionOverUnion(current.box, last.box) < 0.6) return true;
  if (
    current.luma.length !== THUMB_SIZE ** 2 ||
    last.luma.length !== current.luma.length
  )
    return false;
  let diff = 0;
  for (let i = 0; i < current.luma.length; i++)
    diff += Math.abs(current.luma[i] - last.luma[i]);
  return diff / current.luma.length >= VIEW_MAD_FLOOR;
}
export function shouldKeepKeyframe(
  current: KeyframeSample,
  last: KeyframeSample | null,
): boolean {
  'worklet';
  return (
    laplacianVariance(current.luma) >= SHARPNESS_FLOOR &&
    (!last || viewChanged(current, last))
  );
}
/** A proxy for variety, not a measurement of 3D rotation. See object-capture.md M3. */
export function coverageSectors(first: Box, current: Box): number[] {
  const sectors = [0];
  const aspect = current.width / current.height / (first.width / first.height);
  const area = (current.width * current.height) / (first.width * first.height);
  const dx = current.x + current.width / 2 - first.x - first.width / 2;
  const dy = current.y + current.height / 2 - first.y - first.height / 2;
  if (aspect < 0.8) sectors.push(1);
  if (aspect > 1.25) sectors.push(2);
  if (area < 0.7) sectors.push(3);
  if (area > 1.4) sectors.push(4);
  if (dx < -0.1) sectors.push(5);
  if (dx > 0.1) sectors.push(6);
  if (Math.abs(dy) > 0.1) sectors.push(7);
  return sectors;
}
export function coveragePrompt(sectors: readonly number[]): string {
  if (!sectors.includes(1) || !sectors.includes(2)) return 'Xoay sản phẩm';
  if (!sectors.includes(3)) return 'Đưa ra xa';
  if (!sectors.includes(4)) return 'Lại gần';
  if (!sectors.includes(7)) return 'Lật mặt sau';
  return 'Xoay sản phẩm';
}
export function stopDecision(elapsedMs: number, count: number, manual = false) {
  if (count >= MAX_KEYFRAMES) return 'complete';
  if (manual || elapsedMs >= 15000)
    return count >= MIN_KEYFRAMES ? 'complete' : 'retry';
  if (elapsedMs >= 10000) return count >= MIN_KEYFRAMES ? 'complete' : 'extend';
  return 'continue';
}
export function selectLockedTrack(
  objects: readonly TrackedBox[],
  last: TrackedBox,
): TrackedBox | null {
  'worklet';
  const same = objects.find((b) => b.id === last.id);
  if (same) return same;
  let best: TrackedBox | null = null;
  let overlap = 0.3;
  for (const box of objects) {
    const iou = intersectionOverUnion(box, last);
    if (iou >= overlap) {
      best = box;
      overlap = iou;
    }
  }
  return best;
}
export function keyframeReferences(frames: readonly Keyframe[]) {
  return frames
    .filter((frame): frame is Keyframe & { imageId: string } => !!frame.imageId)
    .map((frame) => ({
      image_id: frame.imageId,
      source: 'keyframe' as const,
      // ProductReference expects saved JPEG pixels; never send normalized values to that endpoint.
      bbox: [
        frame.bbox.x * frame.width,
        frame.bbox.y * frame.height,
        frame.bbox.width * frame.width,
        frame.bbox.height * frame.height,
      ].map((value) => Math.round(value * 10000) / 10000),
    }));
}
export function voiceDraftToForm(draft: VoiceUtterance['product_draft']) {
  return {
    name: draft?.name.trim() ?? '',
    price: draft?.price && draft.price > 0 ? String(draft.price) : '',
    unit: draft?.unit?.trim() ?? '',
  };
}
