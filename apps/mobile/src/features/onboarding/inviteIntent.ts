import { create } from 'zustand';

/** A join link can arrive before authentication. Keep it only for this app run. */
export const useInviteIntent = create<{
  token: string;
  setToken: (token: string) => void;
}>((set) => ({
  token: '',
  setToken: (token) => set({ token }),
}));
