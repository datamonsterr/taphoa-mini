import {
  BeVietnamPro_400Regular,
  BeVietnamPro_500Medium,
  BeVietnamPro_600SemiBold,
  BeVietnamPro_700Bold,
  BeVietnamPro_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/be-vietnam-pro';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useCartStore } from '@/stores/cart';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import {
  selectSession,
  selectSignedIn,
  useSessionStore,
} from '@/stores/session';

void SplashScreen.preventAutoHideAsync();

export const unstable_settings = { anchor: 'index' };

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());
  const [fontsLoaded, fontError] = useFonts({
    BeVietnamPro_400Regular,
    BeVietnamPro_500Medium,
    BeVietnamPro_600SemiBold,
    BeVietnamPro_700Bold,
    BeVietnamPro_800ExtraBold,
  });
  const hydrated = useSessionStore((s) => s.hydrated);
  const session = useSessionStore(selectSession);
  const signedIn = useSessionStore(selectSignedIn);
  const hydrate = useSessionStore((s) => s.hydrate);
  const ready = (fontsLoaded || fontError !== null) && hydrated;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Signing out (or a refused refresh) must not leave the previous store's data behind.
  useEffect(() => {
    if (hydrated && !session) {
      queryClient.clear();
      useCartStore.getState().clear();
      useLowStockAlerts.getState().reset();
    }
  }, [hydrated, session, queryClient]);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Protected guard={signedIn} redirectTo="/welcome">
              <Stack.Screen name="index" />
              <Stack.Screen
                name="(shop)"
                options={{ animation: 'slide_from_bottom' }}
              />
              <Stack.Screen name="product/[id]" />
              <Stack.Screen name="pay" />
              <Stack.Screen
                name="cart"
                options={{
                  presentation: 'transparentModal',
                  animation: 'slide_from_bottom',
                }}
              />
              <Stack.Screen
                name="enroll"
                options={{
                  presentation: 'transparentModal',
                  animation: 'slide_from_bottom',
                }}
              />
              <Stack.Screen
                name="expense"
                options={{
                  presentation: 'transparentModal',
                  animation: 'slide_from_bottom',
                }}
              />
              <Stack.Screen
                name="close"
                options={{
                  presentation: 'transparentModal',
                  animation: 'slide_from_bottom',
                }}
              />
            </Stack.Protected>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="(onboarding)" />
            </Stack.Protected>
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
