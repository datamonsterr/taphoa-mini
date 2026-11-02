import { visionDevEnabled } from './dev';

it('gates release builds unless explicitly enabled, following the voice fixture convention', () => {
  const previousDev = __DEV__;
  const previousFlag = process.env.EXPO_PUBLIC_VISION_DEV;
  try {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
    delete process.env.EXPO_PUBLIC_VISION_DEV;
    expect(visionDevEnabled()).toBe(false);
    process.env.EXPO_PUBLIC_VISION_DEV = '1';
    expect(visionDevEnabled()).toBe(true);
    process.env.EXPO_PUBLIC_VISION_DEV = '0';
    expect(visionDevEnabled()).toBe(false);
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
    expect(visionDevEnabled()).toBe(true);
  } finally {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = previousDev;
    if (previousFlag === undefined) delete process.env.EXPO_PUBLIC_VISION_DEV;
    else process.env.EXPO_PUBLIC_VISION_DEV = previousFlag;
  }
});
