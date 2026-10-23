import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Window height the boards are drawn at; keys keep their board size from here up. */
const BOARD_HEIGHT = 844;
export const MIN_KEY_DIAMETER = 48;

/** Key diameter for a usable window height: board size when tall, shrinking 1:4 (4 rows) down to 48. */
export function keypadDiameter(usableHeight: number, boardDiameter = 76) {
  const deficit = Math.max(0, BOARD_HEIGHT - usableHeight);
  const shrunk = Math.round(boardDiameter - deficit / 4);
  return Math.min(boardDiameter, Math.max(MIN_KEY_DIAMETER, shrunk));
}

/** Keypad key diameter that fits the current window (height minus safe-area insets). */
export function useKeypadDiameter(boardDiameter = 76) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return keypadDiameter(height - insets.top - insets.bottom, boardDiameter);
}
