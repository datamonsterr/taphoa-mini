import { colors, radius, shadows, size, space, typography } from './index';

describe('theme tokens', () => {
  test('colours match tokens.css', () => {
    expect(colors.accent).toBe('#5a43e8');
    expect(colors.cameraRing).toBe('#e2a94b');
    expect(colors.scrim).toBe('rgba(12, 12, 14, 0.45)');
    expect(Object.keys(colors)).toHaveLength(21);
  });

  test('space, radius and sizes match tokens.css', () => {
    expect(space).toEqual({ 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 });
    expect(radius).toEqual({ sm: 14, md: 22, lg: 28, xl: 36, full: 9999 });
    expect(size).toEqual({
      tapMin: 56,
      tapLg: 64,
      tapXl: 80,
      shutter: 88,
      icon: 26,
      iconStroke: 2.25,
    });
    expect(shadows.float.shadowOpacity).toBe(0.14);
    expect(shadows.sheet.shadowOffset.height).toBe(-8);
  });

  test('typography matches the text tokens', () => {
    expect(typography.total).toMatchObject({
      fontFamily: 'BeVietnamPro_800ExtraBold',
      fontSize: 56,
      lineHeight: 60,
      letterSpacing: -1,
    });
    expect(typography.price).toMatchObject({ fontSize: 32, lineHeight: 38 });
    expect(typography.title.fontFamily).toBe('BeVietnamPro_800ExtraBold');
    expect(typography.heading).toMatchObject({ fontSize: 22, lineHeight: 28 });
    expect(typography.body.fontFamily).toBe('BeVietnamPro_400Regular');
    expect(typography.label.fontFamily).toBe('BeVietnamPro_600SemiBold');
    expect(typography.caption).toMatchObject({
      fontFamily: 'BeVietnamPro_500Medium',
      fontSize: 15,
      lineHeight: 20,
    });
  });
});
