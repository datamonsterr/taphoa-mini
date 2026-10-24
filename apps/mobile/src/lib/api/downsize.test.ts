import * as ImageManipulator from 'expo-image-manipulator';

import { downsizeForUpload } from './downsize';

describe('downsizeForUpload', () => {
  beforeEach(() => {
    (
      ImageManipulator as unknown as {
        __resizes: Record<string, unknown>[];
      }
    ).__resizes.length = 0;
  });

  test('no-op when dimensions are already <= 1024', async () => {
    const result1 = await downsizeForUpload('file:///photo-800.jpg', 800, 600);
    expect(result1).toEqual({
      uri: 'file:///photo-800.jpg',
      width: 800,
      height: 600,
    });

    const result2 = await downsizeForUpload(
      'file:///photo-1024.jpg',
      1024,
      1024,
    );
    expect(result2).toEqual({
      uri: 'file:///photo-1024.jpg',
      width: 1024,
      height: 1024,
    });

    const resizes = (
      ImageManipulator as unknown as {
        __resizes: Record<string, unknown>[];
      }
    ).__resizes;
    expect(resizes).toHaveLength(0);
  });

  test('resizes landscape image so longest side is 1024', async () => {
    const result = await downsizeForUpload(
      'file:///large-wide.jpg',
      2048,
      1024,
    );
    expect(result.width).toBe(1024);
    expect(result.height).toBe(512);
    expect(result.uri).toMatch(/^file:\/\/\//);

    const resizes = (
      ImageManipulator as unknown as {
        __resizes: { uri: string; width: number; height: number }[];
      }
    ).__resizes;
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toEqual({
      uri: 'file:///large-wide.jpg',
      width: 1024,
      height: 512,
    });
  });

  test('resizes portrait image so longest side is 1024', async () => {
    const result = await downsizeForUpload(
      'file:///large-tall.jpg',
      1500,
      3000,
    );
    expect(result.width).toBe(512);
    expect(result.height).toBe(1024);
    expect(result.uri).toMatch(/^file:\/\/\//);

    const resizes = (
      ImageManipulator as unknown as {
        __resizes: { uri: string; width: number; height: number }[];
      }
    ).__resizes;
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toEqual({
      uri: 'file:///large-tall.jpg',
      width: 512,
      height: 1024,
    });
  });
});
