import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
}

export type TestMetrics = {
  frame: { x: number; y: number; width: number; height: number };
  insets: { top: number; left: number; right: number; bottom: number };
};

const defaultMetrics: TestMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

export function renderWithProviders(
  ui: ReactElement,
  queryClient = createTestQueryClient(),
  metrics: TestMetrics = defaultMetrics,
) {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <GestureHandlerRootView>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>,
  );
}
