import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

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
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(state.isConnected !== false)),
  );
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
