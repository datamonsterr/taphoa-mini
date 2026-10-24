import * as ImageManipulator from 'expo-image-manipulator';

import type { CropRect } from '@/lib/bbox';

/** Crops `uri` to `rect` and returns the new local JPEG uri. */
export async function cropPhoto(uri: string, rect: CropRect): Promise<string> {
  const context = ImageManipulator.ImageManipulator.manipulate(uri).crop(rect);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: ImageManipulator.SaveFormat.JPEG,
    compress: 0.85,
  });
  return saved.uri;
}
