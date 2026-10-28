import type { CameraPictureOptions } from 'expo-camera';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { CaptureMode } from '@/components/camera';
import type { ScanMode, UploadFile } from '@/lib/api/types';

import type { Photo } from './scanReducer';

/** The part of `CameraView` the screen uses. */
export type PictureTaker = {
  takePictureAsync: (
    options: CameraPictureOptions,
  ) => Promise<{ uri: string; width: number; height: number } | undefined>;
};

/** Captures a JPEG at quality 0.6 (small upload, enough for the matcher). */
export async function takePhoto(camera: PictureTaker | null): Promise<Photo> {
  if (!camera) throw new Error('camera not ready');
  const picture = await captureStill(camera, { quality: 0.6 });
  if (!picture) throw new Error('no photo');
  return { uri: picture.uri, width: picture.width, height: picture.height };
}

export function toUploadFile(photo: Photo): UploadFile {
  return { uri: photo.uri, name: 'scan.jpg', type: 'image/jpeg' };
}

export function toScanMode(mode: CaptureMode): ScanMode {
  return mode === 'one' ? 'single' : 'multi';
}

// A shutter press waits for the current silent capture, including when it just lost focus.
const captures = new WeakMap<PictureTaker, Promise<unknown>>();
function captureStill(camera: PictureTaker, options: CameraPictureOptions) {
  const previous = captures.get(camera);
  const next = previous
    ? previous.catch(() => {}).then(() => camera.takePictureAsync(options))
    : camera.takePictureAsync(options);
  captures.set(camera, next);
  void next
    .finally(() => {
      if (captures.get(camera) === next) captures.delete(camera);
    })
    .catch(() => {});
  return next;
}

/** Only temporary probe files are deleted; full shutter photos belong to their session. */
export function discardProbePhoto(uri: string) {
  if (!uri.startsWith('file:')) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cache eviction or a failed capture may already have removed it.
  }
}

/** SDK 58 skips quality with skipProcessing; always recompress after resizing. */
export async function takeProbePhoto(
  camera: PictureTaker | null,
): Promise<Photo> {
  if (!camera) throw new Error('camera not ready');
  const picture = await captureStill(camera, {
    quality: 0.2,
    shutterSound: false,
    skipProcessing: true,
  });
  if (!picture) throw new Error('no photo');
  try {
    // The bounded loader preserves EXIF orientation and aspect ratio on native and web.
    // Raw camera dimensions can be unrotated when skipProcessing is enabled.
    const context = ImageManipulator.manipulate(picture.uri, {
      maxWidth: 640,
      maxHeight: 640,
    });
    const image = await context.renderAsync();
    return await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.3 });
  } finally {
    discardProbePhoto(picture.uri);
  }
}
