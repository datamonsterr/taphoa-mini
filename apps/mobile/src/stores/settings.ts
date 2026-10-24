import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Language = 'vi' | 'en';

type SettingsState = {
  elderMode: boolean;
  fontScale: number;
  language: Language;
  setElderMode: (on: boolean) => void;
  setFontScale: (scale: number) => void;
  setLanguage: (language: Language) => void;
};

export const initialSettings = {
  elderMode: false,
  fontScale: 1,
  language: 'vi' as Language,
};

export const SETTINGS_STORAGE_KEY = 'taphoa-settings';

/** Settings survive app restarts; only the choices are stored, not the setters. */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...initialSettings,
      setElderMode: (elderMode) => set({ elderMode }),
      setFontScale: (fontScale) => set({ fontScale }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ elderMode, fontScale, language }) => ({
        elderMode,
        fontScale,
        language,
      }),
    },
  ),
);
