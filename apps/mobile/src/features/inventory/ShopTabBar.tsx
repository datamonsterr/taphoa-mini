import { router } from 'expo-router';
import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomBar, type ShopTab } from '@/components/ui/BottomBar';
import { useT } from '@/lib/i18n';
import { useChromeStore } from '@/stores/chrome';
import { space } from '@/theme';

import { strings } from './strings';

export type ShopTabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>['tabBar']>
>[0];

/** Floating bottom bar of the shop tabs: camera FAB on the left, Kho / Báo cáo / Tài khoản pill. */
export function ShopTabBar({ state, navigateToTab, insets }: ShopTabBarProps) {
  const t = useT(strings);
  const hidden = useChromeStore((s) => s.tabBarHidden);
  const labels = {
    inventory: t('tab.inventory'),
    dashboard: t('tab.dashboard'),
    account: t('tab.account'),
    camera: t('tab.camera'),
    nav: t('tab.nav'),
  };
  const current = state.routes[state.index]!.name as ShopTab;
  const onSelect = useCallback(
    (tab: ShopTab) => {
      const route = state.routes.find((r) => r.name === tab);
      if (route) navigateToTab(route.key);
    },
    [state.routes, navigateToTab],
  );
  const onCameraPress = useCallback(() => router.dismissTo('/'), []);
  if (hidden) return null;
  return (
    <View
      testID="shop-tab-bar"
      pointerEvents="box-none"
      style={[styles.bar, { bottom: space[4] + insets.bottom }]}
    >
      <BottomBar
        current={current}
        onSelect={onSelect}
        onCameraPress={onCameraPress}
        labels={labels}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: space[4], right: space[4] },
});
