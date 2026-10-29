import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

let installed = false;

/**
 * Feeds TanStack Query's `onlineManager` from NetInfo (once). Only `isConnected` counts: NetInfo's
 * own reachability probe is switched off (it fetches a third-party URL, which web and the e2e stack
 * block); a connected phone with no route fails its requests, and those retry with backoff.
 */
export function installOnlineManager(): void {
  if (installed) return;
  installed = true;
  NetInfo.configure({ reachabilityShouldRun: () => false });
  onlineManager.setEventListener((setOnline) => {
    const unsubscribe = NetInfo.addEventListener((state) =>
      setOnline(state.isConnected !== false),
    );
    if (Platform.OS !== 'web' || typeof window === 'undefined')
      return unsubscribe;
    // NetInfo on web listens to `navigator.connection` change events, which Chromium does not fire
    // when the network drops (DevTools, Playwright); the window events always fire.
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      unsubscribe();
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  });
}

/** Test hook: forget the install so the next call wires the listener again. */
export function resetOnlineManagerInstall(): void {
  installed = false;
}

/** Whether the phone has a network connection; re-renders when it changes. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    onlineManager.subscribe.bind(onlineManager),
    () => onlineManager.isOnline(),
    () => true,
  );
}
