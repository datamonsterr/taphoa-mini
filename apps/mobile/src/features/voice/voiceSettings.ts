import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { preferenceStorage } from '@/stores/preferenceStorage';

type VoiceSettings = {
  /** "Góp giọng nói để cải thiện": stored on this phone only until the upload follow-up lands. */
  donate: boolean;
  /** Voice sales confirmed on this phone; the `voice_sale` chip stops after three. */
  voiceSales: number;
  setDonate: (on: boolean) => void;
  countVoiceSale: () => void;
};

export const initialVoiceSettings = { donate: false, voiceSales: 0 };
export const VOICE_SETTINGS_KEY = 'taphoa-voice';

export const useVoiceSettings = create<VoiceSettings>()(
  persist(
    (set) => ({
      ...initialVoiceSettings,
      setDonate: (donate) => set({ donate }),
      countVoiceSale: () => set((s) => ({ voiceSales: s.voiceSales + 1 })),
    }),
    {
      name: VOICE_SETTINGS_KEY,
      version: 1,
      storage: preferenceStorage(),
      partialize: ({ donate, voiceSales }) => ({ donate, voiceSales }),
    },
  ),
);
