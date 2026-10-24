import { create } from 'zustand';

import type { CaptureMode } from '@/components/camera';

type ModeState = {
  mode: CaptureMode;
  setMode: (mode: CaptureMode) => void;
};

/** Mode toggle choice (one / many); outlives the screen so it survives navigation. */
export const useCaptureModeStore = create<ModeState>()((set) => ({
  mode: 'one',
  setMode: (mode) => set({ mode }),
}));

export const selectMode = (s: ModeState) => s.mode;
