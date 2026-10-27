import {
  BeVietnamPro_400Regular,
  BeVietnamPro_500Medium,
  BeVietnamPro_600SemiBold,
  BeVietnamPro_700Bold,
  BeVietnamPro_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/be-vietnam-pro';
import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { AnalyticsIdentity, AnalyticsSignedOut } from '@/lib/AnalyticsIdentity';
import { AnalyticsProvider } from '@/lib/analyticsPostHog';
import { AuthGate } from '@/features/auth/AuthGate';
import { ConfigurationError } from '@/features/auth/ConfigurationError';
import {
  configureNotificationHandler,
  useNotificationObserver,
} from '@/lib/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

void SplashScreen.preventAutoHideAsync();

configureNotificationHandler();

export const unstable_settings = { anchor: 'index' };

function NavigationTree({
  ready,
  signedIn,
  hasMembership,
}: {
  ready: boolean;
  signedIn: boolean;
  hasMembership: boolean;
}) {
  useNotificationObserver(ready && signedIn);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected
        guard={hasMembership}
        redirectTo={signedIn ? '/welcome' : '/sign-in'}
      >
        <Stack.Screen name="index" />
        <Stack.Screen
          name="(shop)"
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen name="product/[id]" />
        <Stack.Screen name="stock" />
        <Stack.Screen name="receipt/[id]" />
        <Stack.Screen name="receipts" />
        <Stack.Screen name="debts" />
        <Stack.Screen name="digest" />
        <Stack.Screen name="customer/[id]" />
        <Stack.Screen name="pay" />
        <Stack.Screen
          name="cart"
          options={{
            presentation: 'transparentModal',
            animation: 'slide_from_bottom',
          }}
        />
        <Stack.Screen
          name="assistant"
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
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected
        guard={signedIn && !hasMembership}
        redirectTo={signedIn ? '/' : '/sign-in'}
      >
        <Stack.Screen name="(onboarding)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());
  const [fontsLoaded, fontError] = useFonts({
    BeVietnamPro_400Regular,
    BeVietnamPro_500Medium,
    BeVietnamPro_600SemiBold,
    BeVietnamPro_700Bold,
    BeVietnamPro_800ExtraBold,
  });
  const ready = fontsLoaded || fontError !== null;
  const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

  useEffect(() => () => queryClient.clear(), [queryClient]);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          {!publishableKey ? (
            <ConfigurationError />
          ) : (
            <ClerkProvider
              publishableKey={publishableKey}
              tokenCache={tokenCache}
            >
              <AnalyticsProvider>
                <StatusBar style="dark" />
                <AuthGate>
                  {({ signedIn, hasMembership }) => (
                    <>
                      {hasMembership ? (
                        <AnalyticsIdentity />
                      ) : (
                        <AnalyticsSignedOut />
                      )}
                      <NavigationTree
                        ready={ready}
                        signedIn={signedIn}
                        hasMembership={hasMembership}
                      />
                    </>
                  )}
                </AuthGate>
              </AnalyticsProvider>
            </ClerkProvider>
          )}
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
