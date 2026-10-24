import { Tabs } from 'expo-router';
import { View } from 'react-native';

import { ShopTabBar } from '@/features/inventory/ShopTabBar';
import { LowStockBanner } from '@/features/stock-alerts/LowStockBanner';
import { useLowStockWatcher } from '@/features/stock-alerts/useLowStockWatcher';
import { colors } from '@/theme';

export const unstable_settings = { anchor: 'inventory' };

/**
 * Shop tabs. Screens stay mounted once opened and switch with no animation,
 * so a tab change never remounts or flashes.
 */
export default function ShopLayout() {
  useLowStockWatcher();
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <LowStockBanner />
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
    </View>
  );
}
