import { StyleSheet } from 'react-native';

import { camera, colors, size, space } from '@/theme';

export const BOARD_VIEWFINDER = 358;
export const STRIP_SLOT = 80;
/** Everything on the board except the viewfinder, so small phones can shrink the square. */
/** Gap between the mode toggle and the viewfinder on the board (76 -> 136). */
export const FINDER_GAP = 60;
export const FIXED_HEIGHT =
  20 + 56 + FINDER_GAP + 8 + STRIP_SLOT + 8 + 64 + 16 + 56 + 32;

export const styles = StyleSheet.create({
  receiptBusy: {
    flex: 1,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[4],
  },
  hidden: { display: 'none' },
  screen: { flex: 1, backgroundColor: colors.cameraBg },
  modeRow: { alignItems: 'center' },
  codeModeButton: {
    position: 'absolute',
    right: space[4],
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: space[2],
  },
  codeModeText: { color: camera.white },
  finderRow: { alignItems: 'center', marginTop: FINDER_GAP },
  stripSlot: {
    height: STRIP_SLOT,
    marginTop: space[2],
    justifyContent: 'center',
  },
  indexChip: {
    color: colors.accent,
    backgroundColor: camera.glass,
    alignSelf: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: 999,
  },
  quickHint: { color: colors.accent, textAlign: 'center' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginTop: space[2],
  },
  arrow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -38,
    alignItems: 'center',
  },
  spacer: { flex: 1, minHeight: 16 },
  bottomRow: {
    height: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
  },
  handle: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  busy: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: camera.pillDark,
  },
});
