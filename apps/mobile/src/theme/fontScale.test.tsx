import { renderHook } from '@testing-library/react-native';

import { initialSettings, useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { ScaledText, Text } from '@/components/ui';
import { typography } from '@/theme';

import {
  ELDER_FONT_SCALE_FLOOR,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  clampFontScale,
  formatScale,
  scaleText,
  stepFontScale,
  useFontScale,
  useMinFontScale,
  useScaledTypography,
} from './fontScale';

beforeEach(() => useSettingsStore.setState(initialSettings));

test('clamps and snaps to quarter steps', () => {
  expect(clampFontScale(0.5)).toBe(FONT_SCALE_MIN);
  expect(clampFontScale(3)).toBe(FONT_SCALE_MAX);
  expect(clampFontScale(1.3)).toBe(1.25);
});

test('steps up and down within bounds', () => {
  expect(stepFontScale(1, 1)).toBe(1.25);
  expect(stepFontScale(1, -1)).toBe(1);
  expect(stepFontScale(2, 1)).toBe(2);
  expect(stepFontScale(1.5, -1)).toBe(1.25);
});

test('formats as a percentage', () => {
  expect(formatScale(1)).toBe('100%');
  expect(formatScale(1.75)).toBe('175%');
});

test('scaleText multiplies size and line height', () => {
  expect(scaleText({ fontSize: 18, lineHeight: 26 }, 1.5)).toEqual({
    fontSize: 27,
    lineHeight: 39,
  });
  expect(scaleText({ color: 'red' }, 2)).toEqual({ color: 'red' });
});

test('useFontScale reads the settings store', async () => {
  const { result } = await renderHook(() => useFontScale());
  expect(result.current).toBe(1);
});

test('useScaledTypography scales every variant', async () => {
  useSettingsStore.setState({ fontScale: 2 });
  const { result } = await renderHook(() => useScaledTypography());
  expect(result.current.body.fontSize).toBe(typography.body.fontSize! * 2);
  expect(result.current.total.lineHeight).toBe(
    typography.total.lineHeight! * 2,
  );
});

test('ScaledText scales its variant', async () => {
  useSettingsStore.setState({ fontScale: 1.5 });
  const view = await renderWithProviders(
    <ScaledText variant="heading">Xin chào</ScaledText>,
  );
  expect(view.getByText('Xin chào')).toHaveStyle({
    fontSize: typography.heading.fontSize! * 1.5,
  });
});

test('elder mode raises the effective scale to 125 % and the minimum with it', async () => {
  useSettingsStore.setState({ elderMode: true, fontScale: 1 });
  const { result } = await renderHook(() => [
    useFontScale(),
    useMinFontScale(),
  ]);
  expect(result.current).toEqual([
    ELDER_FONT_SCALE_FLOOR,
    ELDER_FONT_SCALE_FLOOR,
  ]);
  useSettingsStore.setState({ fontScale: 1.75 });
  const next = await renderHook(() => useFontScale());
  expect(next.result.current).toBe(1.75);
});

test('Text is a drop-in that scales any style, not only variants', async () => {
  useSettingsStore.setState({ fontScale: 1.5 });
  const view = await renderWithProviders(
    <Text style={[{ fontSize: 20, lineHeight: 24 }, { color: 'red' }]}>
      Giá
    </Text>,
  );
  expect(view.getByText('Giá')).toHaveStyle({
    fontSize: 30,
    lineHeight: 36,
    color: 'red',
  });
});
