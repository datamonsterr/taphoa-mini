import { Tabs } from 'expo-router';
import { View } from 'react-native';

import { ShopTabBar } from '@/features/inventory/ShopTabBar';
import { LowStockBanner } from '@/features/stock-alerts/LowStockBanner';
import { useLowStockWatcher } from '@/features/stock-alerts/useLowStockWatcher';
import { currentStoreId } from '@/lib/api/clerkBridge';
import { useStoreEvents } from '@/lib/api/useStoreEvents';
import { useCurrentStore } from '@/stores/currentStore';
import { usePushRegistration } from '@/lib/notifications';
import { colors } from '@/theme';

export const unstable_settings = { anchor: 'inventory' };

/**
 * Shop tabs. Screens stay mounted once opened and switch with no animation,
 * so a tab change never remounts or flashes.
 */
export default function ShopLayout() {
  const { refreshOnFocus } = useLowStockWatcher();
  // Subscribe to store selection so switching stores tears down the old stream.
  useCurrentStore((state) => state.storeIds);
  useStoreEvents(currentStoreId());
  usePushRegistration();
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <LowStockBanner />
      <Tabs
        detachInactiveScreens={false}
        // Tabs stay mounted, so a layout-level useFocusEffect would not see tab
        // switches; the navigator's focus event also fires when a pushed screen
        // is popped back to a tab.
        screenListeners={{ focus: refreshOnFocus }}
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
