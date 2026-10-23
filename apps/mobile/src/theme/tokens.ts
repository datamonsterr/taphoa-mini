/** Mirrors docs/design/canvas/ds/taphoa/tokens.css. Do not hard-code colours elsewhere. */
export const colors = {
  surface: '#ffffff',
  surfaceSoft: '#f3f3f5',
  surfacePressed: '#e7e7eb',
  ink: '#111114',
  inkMuted: '#5f5f66',
  lineStrong: '#8a8a92',
  onInk: '#ffffff',
  accent: '#5a43e8',
  onAccent: '#ffffff',
  accentSoft: '#eeecfd',
  success: '#18703c',
  successSoft: '#e4f4ea',
  warning: '#a34f00',
  warningSoft: '#fdf0dc',
  danger: '#c62f2f',
  dangerSoft: '#fde8e8',
  cameraBg: '#0c0c0e',
  cameraInk: '#ffffff',
  cameraMuted: '#a1a1a8',
  cameraRing: '#e2a94b',
  scrim: 'rgba(12, 12, 14, 0.45)',
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;

export const radius = { sm: 14, md: 22, lg: 28, xl: 36, full: 9999 } as const;

export const size = {
  tapMin: 56,
  tapLg: 64,
  tapXl: 80,
  shutter: 88,
  icon: 26,
  iconStroke: 2.25,
} as const;

/** React Native shadow props for `--shadow-float` and `--shadow-sheet`. */
export const shadows = {
  float: {
    shadowColor: '#111114',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.14,
    shadowRadius: 30,
    elevation: 8,
  },
  sheet: {
    shadowColor: '#111114',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.16,
    shadowRadius: 40,
    elevation: 16,
  },
} as const;
