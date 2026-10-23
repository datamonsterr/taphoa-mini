import type { CaptureMode } from '@/components/camera';
import type { ScanMode, UploadFile } from '@/lib/api/types';

import type { Photo } from './scanReducer';

/** The part of `CameraView` the screen uses. */
export type PictureTaker = {
  takePictureAsync: (options: {
    quality: number;
  }) => Promise<{ uri: string; width: number; height: number } | undefined>;
};

/** Captures a JPEG at quality 0.6 (small upload, enough for the matcher). */
export async function takePhoto(camera: PictureTaker | null): Promise<Photo> {
  if (!camera) throw new Error('camera not ready');
  const picture = await camera.takePictureAsync({ quality: 0.6 });
  if (!picture) throw new Error('no photo');
  return { uri: picture.uri, width: picture.width, height: picture.height };
}

export function toUploadFile(photo: Photo): UploadFile {
  return { uri: photo.uri, name: 'scan.jpg', type: 'image/jpeg' };
}

export function toScanMode(mode: CaptureMode): ScanMode {
  return mode === 'one' ? 'single' : 'multi';
}
