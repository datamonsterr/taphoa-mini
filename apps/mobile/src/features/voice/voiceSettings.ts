import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { preferenceStorage } from '@/stores/preferenceStorage';
import { bridgeUserId } from '@/lib/api/clerkBridge';

type VoiceSettings = {
  /** "Góp giọng nói để cải thiện": sent as `donate=true` with a sale clip so the server keeps it for the golden set. */
  donations: Record<string, boolean>;
  /** Voice sales confirmed on this phone; the `voice_sale` chip stops after three. */
  voiceSales: number;
  setDonate: (on: boolean) => void;
  countVoiceSale: () => void;
};

export const initialVoiceSettings = {
  donations: {} as Record<string, boolean>,
  voiceSales: 0,
};
export const VOICE_SETTINGS_KEY = 'taphoa-voice';

export const useVoiceSettings = create<VoiceSettings>()(
  persist(
    (set) => ({
      ...initialVoiceSettings,
      setDonate: (donate) => {
        const userId = bridgeUserId();
        if (userId)
          set((s) => ({ donations: { ...s.donations, [userId]: donate } }));
      },
      countVoiceSale: () => set((s) => ({ voiceSales: s.voiceSales + 1 })),
    }),
    {
      name: VOICE_SETTINGS_KEY,
      version: 3,
      migrate: (state) => ({
        ...(state as { voiceSales?: number }),
        donations: {},
      }),
      storage: preferenceStorage(),
      partialize: ({ donations, voiceSales }) => ({ donations, voiceSales }),
    },
  ),
);
