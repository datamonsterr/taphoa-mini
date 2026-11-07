/** Same opt-in pattern as voice fixtures; release builds default to inaccessible. */
export const visionDevEnabled = () =>
  __DEV__ || process.env.EXPO_PUBLIC_VISION_DEV === '1';
