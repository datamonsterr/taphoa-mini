import * as ImageManipulator from 'expo-image-manipulator';

const MAX_SIDE = 1024;

/**
 * Resizes an image so its longest side is at most 1024 px before upload.
 * No-op when both width and height are already <= 1024.
 */
export async function downsizeForUpload(
  uri: string,
  width: number,
  height: number,
): Promise<{ uri: string; width: number; height: number }> {
  const longest = Math.max(width, height);
  if (longest <= MAX_SIDE) {
    return { uri, width, height };
  }

  const scale = MAX_SIDE / longest;
  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);

  const context = ImageManipulator.ImageManipulator.manipulate(uri).resize({
    width: targetWidth,
    height: targetHeight,
  });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: ImageManipulator.SaveFormat.JPEG,
    compress: 0.85,
  });

  return {
    uri: saved.uri,
    width: saved.width ?? targetWidth,
    height: saved.height ?? targetHeight,
  };
}
