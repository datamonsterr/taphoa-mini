import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Language = 'vi' | 'en';

type SettingsState = {
  elderMode: boolean;
  /** Read the total (and the change) aloud on the pay sheet. */
  speakTotal: boolean;
  fontScale: number;
  language: Language;
  setElderMode: (on: boolean) => void;
  setSpeakTotal: (on: boolean) => void;
  setFontScale: (scale: number) => void;
  setLanguage: (language: Language) => void;
};

export const initialSettings = {
  elderMode: false,
  speakTotal: false,
  fontScale: 1,
  language: 'vi' as Language,
};

export const SETTINGS_STORAGE_KEY = 'taphoa-settings';

/** Settings survive app restarts; only the choices are stored, not the setters. */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...initialSettings,
      /** Turning elder mode on also turns the spoken total on; the seller can switch it off after. */
      setElderMode: (elderMode) =>
        set(elderMode ? { elderMode, speakTotal: true } : { elderMode }),
      setSpeakTotal: (speakTotal) => set({ speakTotal }),
      setFontScale: (fontScale) => set({ fontScale }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 2,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<typeof initialSettings>;
        // v1 had no speakTotal: elder-mode users get it on, like a fresh switch.
        return version < 2
          ? { ...state, speakTotal: state.elderMode === true }
          : state;
      },
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ elderMode, speakTotal, fontScale, language }) => ({
        elderMode,
        speakTotal,
        fontScale,
        language,
      }),
    },
  ),
);
