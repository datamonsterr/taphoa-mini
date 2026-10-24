import { Tabs } from 'expo-router';

import { ShopTabBar } from '@/features/inventory/ShopTabBar';

export const unstable_settings = { anchor: 'inventory' };

/**
 * Shop tabs. Screens stay mounted once opened and switch with no animation,
 * so a tab change never remounts or flashes.
 */
export default function ShopLayout() {
  return (
    <Tabs
      detachInactiveScreens={false}
      tabBar={(props) => <ShopTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        animation: 'none',
      }}
    >
      <Tabs.Screen name="inventory" />
      <Tabs.Screen name="dashboard" />
      <Tabs.Screen name="account" />
    </Tabs>
  );
}
