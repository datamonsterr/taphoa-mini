import {
  chatButtonPlacement,
  MIN_BESIDE_WIDTH,
  barFrames,
} from './chatButtonPlacement';

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test('sits beside the pill when the pill keeps its three 56 dp tabs', () => {
  // inset 16 + fab 64 + gap 12 + pill (3 x 56 + 12 padding) + gap 12 + button 56 + inset 16
  expect(MIN_BESIDE_WIDTH).toBe(16 + 64 + 12 + 180 + 12 + 56 + 16);
  expect(chatButtonPlacement(MIN_BESIDE_WIDTH)).toBe('beside');
  expect(chatButtonPlacement(390)).toBe('beside');
  expect(chatButtonPlacement(1024)).toBe('beside');
});

test('moves above the right end of the bar when the window is narrower', () => {
  expect(chatButtonPlacement(MIN_BESIDE_WIDTH - 1)).toBe('above');
  expect(chatButtonPlacement(320)).toBe('above');
});

test.each([320, 340, MIN_BESIDE_WIDTH - 1, MIN_BESIDE_WIDTH, 390, 600, 1024])(
  'the button frame never overlaps the camera FAB or a tab at width %i',
  (width) => {
    const frames = barFrames(width);
    expect(frames.tabs).toHaveLength(3);
    for (const target of [frames.fab, ...frames.tabs])
      expect(overlaps(frames.chat, target)).toBe(false);
    // Same right inset as the bar, and fully inside the window.
    expect(frames.chat.x + frames.chat.width).toBe(width - 16);
    expect(frames.chat.x).toBeGreaterThanOrEqual(0);
    for (const tab of frames.tabs) expect(tab.width).toBe(56);
  },
);

test('the narrow fallback sits one gap above the bar', () => {
  const frames = barFrames(320);
  expect(frames.chat.y + frames.chat.height + 12).toBe(frames.bar.y);
});
