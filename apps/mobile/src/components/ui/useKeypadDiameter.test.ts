import { keypadDiameter, MIN_KEY_DIAMETER } from './useKeypadDiameter';

test('keeps the board size from 844 up', () => {
  expect(keypadDiameter(844)).toBe(76);
  expect(keypadDiameter(1200)).toBe(76);
  expect(keypadDiameter(844, 68)).toBe(68);
});

test('shrinks one quarter of the missing height per key', () => {
  expect(keypadDiameter(804)).toBe(66);
});

test('never goes below the minimum tap size', () => {
  expect(keypadDiameter(560)).toBe(MIN_KEY_DIAMETER);
  expect(keypadDiameter(0, 68)).toBe(MIN_KEY_DIAMETER);
});
