import { ChartColumn, Focus, Package, User } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius, shadows, size, space } from '@/theme';

import { CircleButton } from './CircleButton';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type ShopTab = 'inventory' | 'dashboard' | 'account';

const TABS = [
  { id: 'inventory', icon: Package },
  { id: 'dashboard', icon: ChartColumn },
  { id: 'account', icon: User },
] as const;

/** Accessibility labels of the bar; Vietnamese unless the caller passes its own. */
export type BottomBarLabels = Record<ShopTab, string> & {
  camera: string;
  nav: string;
};

export const defaultLabels: BottomBarLabels = {
  inventory: 'Kho',
  dashboard: 'Báo cáo',
  account: 'Tài khoản',
  camera: 'Mở camera',
  nav: 'Chính',
};

export type CameraFabProps = {
  onPress: () => void;
  label?: string;
};

/** Accent circle that returns to the camera. */
export const CameraFab = memo(function CameraFab({
  onPress,
  label = defaultLabels.camera,
}: CameraFabProps) {
  return (
    <CircleButton
      icon={Focus}
      accessibilityLabel={label}
      variant="accent"
      large
      floating
      onPress={onPress}
    />
  );
});

export type NavPillProps = {
  current: ShopTab;
  onSelect: (tab: ShopTab) => void;
  labels?: BottomBarLabels;
};

/** Floating pill with Kho, Báo cáo, Tài khoản. The current tab is filled ink. */
export const NavPill = memo(function NavPill({
  current,
  onSelect,
  labels = defaultLabels,
}: NavPillProps) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={labels.nav}
      style={styles.nav}
    >
      {TABS.map(({ id, icon }) => {
        const on = id === current;
        return (
          <PressableScale
            key={id}
            accessibilityRole="tab"
            accessibilityLabel={labels[id]}
            accessibilityState={{ selected: on }}
            aria-selected={on}
            onPress={() => onSelect(id)}
            style={[styles.tab, on && styles.tabOn]}
          >
            <Icon icon={icon} color={on ? colors.onInk : colors.inkMuted} />
          </PressableScale>
        );
      })}
    </View>
  );
});

export type BottomBarProps = {
  current: ShopTab;
  onSelect: (tab: ShopTab) => void;
  onCameraPress: () => void;
  labels?: BottomBarLabels;
};

export const BottomBar = memo(function BottomBar({
  current,
  onSelect,
  onCameraPress,
  labels = defaultLabels,
}: BottomBarProps) {
  return (
    <View style={styles.wrap}>
      <CameraFab onPress={onCameraPress} label={labels.camera} />
      <NavPill current={current} onSelect={onSelect} labels={labels} />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  nav: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    height: size.tapLg,
    paddingHorizontal: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  tab: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  tabOn: { backgroundColor: colors.ink },
});
