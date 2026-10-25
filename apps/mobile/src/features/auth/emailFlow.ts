import { create } from 'zustand';
/** An in-flight email is ephemeral and never written to storage or URLs. */
export const useEmailFlow = create<{
  email: string;
  mode: 'signIn' | 'signUp';
  begin: (email: string, mode: 'signIn' | 'signUp') => void;
  reset: () => void;
}>((set) => ({
  email: '',
  mode: 'signIn',
  begin: (email, mode) => set({ email, mode }),
  reset: () => set({ email: '', mode: 'signIn' }),
}));
