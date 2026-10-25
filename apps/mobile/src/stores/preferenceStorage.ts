import AsyncStorage from '@react-native-async-storage/async-storage';
import { createJSONStorage } from 'zustand/middleware';

/** Preferences are not worth failing for: blocked storage reads as empty and writes are dropped. */
export const preferenceStorage = () =>
  createJSONStorage(() => ({
    getItem: (key) => AsyncStorage.getItem(key).catch(() => null),
    setItem: (key, value) =>
      AsyncStorage.setItem(key, value).catch(() => undefined),
    removeItem: (key) => AsyncStorage.removeItem(key).catch(() => undefined),
  }));
