/** Translucent camera-surface fills from the boards (`rgba(...)` literals in Components/Multi/Match). */
export const camera = {
  white: '#ffffff',
  viewfinderBg: '#2a2a2e',
  glass: 'rgba(255, 255, 255, 0.14)',
  boxOffLine: 'rgba(255, 255, 255, 0.55)',
  badgeOffLine: 'rgba(255, 255, 255, 0.7)',
  badgeOffFill: 'rgba(12, 12, 14, 0.5)',
  pillDark: 'rgba(12, 12, 14, 0.7)',
  chipDark: 'rgba(12, 12, 14, 0.82)',
  accentTint: 'rgba(90, 67, 232, 0.22)',
  accentGlow: 'rgba(90, 67, 232, 0.6)',
  accentHalo: 'rgba(90, 67, 232, 0.35)',
  warningHalo: 'rgba(253, 240, 220, 0.45)',
  cornerMark: 'rgba(255, 255, 255, 0.85)',
  shadow: '#000000',
} as const;
