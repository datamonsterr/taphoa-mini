import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** Key/value storage for the session: Keychain / Keystore on a phone, `localStorage` on the web. */
export type SessionStorage = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const webStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage (private mode, sandboxed frame): the session then lives in memory only.
    return null;
  }
};

const web: SessionStorage = {
  get: async (key) => webStorage()?.getItem(key) ?? null,
  set: async (key, value) => webStorage()?.setItem(key, value),
  remove: async (key) => webStorage()?.removeItem(key),
};

const native: SessionStorage = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

/** Picked per call, so a test (or a hot reload) that changes `Platform.OS` is honoured. */
export const sessionStorage = (): SessionStorage =>
  Platform.OS === 'web' ? web : native;
