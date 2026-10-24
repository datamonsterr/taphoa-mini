import type { LucideIcon } from 'lucide-react-native';

import { colors, size } from '@/theme';

type IconProps = {
  icon: LucideIcon;
  size?: number;
  strokeWidth?: number;
  color?: string;
};

/** Lucide line icon at the design-system size (26) and stroke (2.25). */
export function Icon({
  icon: Glyph,
  size: iconSize = size.icon,
  strokeWidth = size.iconStroke,
  color = colors.ink,
}: IconProps) {
  return (
    <Glyph
      size={iconSize}
      strokeWidth={strokeWidth}
      color={color}
      aria-hidden
    />
  );
}
