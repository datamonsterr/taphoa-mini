import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { CaptureMode } from '@/components/camera';
import { preferenceStorage } from '@/stores/preferenceStorage';

type ModeState = {
  mode: CaptureMode;
  setMode: (mode: CaptureMode) => void;
};

export const migrateMode = (mode: unknown): CaptureMode =>
  mode === 'code' ? 'code' : 'object';

export const useCaptureModeStore = create<ModeState>()(
  persist((set) => ({ mode: 'object', setMode: (mode) => set({ mode }) }), {
    name: 'taphoa-camera-mode',
    storage: preferenceStorage(),
    partialize: ({ mode }) => ({ mode }),
    merge: (persisted, current) => ({
      ...current,
      mode: migrateMode((persisted as { mode?: unknown } | undefined)?.mode),
    }),
  }),
);

export const selectMode = (s: ModeState) => s.mode;
