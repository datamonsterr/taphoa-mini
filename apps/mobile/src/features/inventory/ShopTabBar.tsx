import { router } from 'expo-router';
import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { ChatButton } from '@/components/assistant/ChatButton';
import { useAssistantEnabled } from '@/features/assistant/flags';
import { BottomBar, type ShopTab } from '@/components/ui/BottomBar';
import { useT } from '@/lib/i18n';
import { useChromeStore } from '@/stores/chrome';
import { space } from '@/theme';

import { chatButtonPlacement } from './chatButtonPlacement';
import { strings } from './strings';

export type ShopTabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>['tabBar']>
>[0];

/**
 * Floating bottom bar of the shop tabs: camera FAB on the left, Kho / Báo cáo / Tài khoản pill, and
 * the assistant button to the right of the pill (above its right end on a narrow window).
 */
export function ShopTabBar({ state, navigateToTab, insets }: ShopTabBarProps) {
  const t = useT(strings);
  const { width } = useWindowDimensions();
  const assistant = useAssistantEnabled();
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
  const bottomBar = (
    <BottomBar
      current={current}
      onSelect={onSelect}
      onCameraPress={onCameraPress}
      labels={labels}
    />
  );
  const beside = chatButtonPlacement(width) === 'beside';
  if (hidden) return null;
  return (
    <View
      testID="shop-tab-bar"
      pointerEvents="box-none"
      style={[styles.bar, { bottom: space[4] + insets.bottom }]}
    >
      {assistant ? (
        <View
          testID="shop-tab-row"
          pointerEvents="box-none"
          style={beside ? styles.row : styles.column}
        >
          <View
            pointerEvents="box-none"
            style={beside ? styles.grow : undefined}
          >
            {bottomBar}
          </View>
          <View
            testID="chat-button-slot"
            pointerEvents="box-none"
            style={beside ? undefined : styles.above}
          >
            <ChatButton screen={current} />
          </View>
        </View>
      ) : (
        bottomBar
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: space[4], right: space[4] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  column: { flexDirection: 'column-reverse' },
  grow: { flex: 1 },
  above: { alignSelf: 'flex-end', marginBottom: space[3] },
});
