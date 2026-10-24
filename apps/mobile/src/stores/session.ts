import { create } from 'zustand';

import type { components } from '@taphoa/api-client';

import { sessionStorage } from './sessionStorage';

type Schemas = components['schemas'];

/** What the phone keeps after create / join / recover: the token pair plus who and where. */
export type Session = {
  access_token: string;
  refresh_token: string;
  member: Schemas['Member'];
  store: Schemas['Store'];
};

export const SESSION_STORAGE_KEY = 'taphoa-session';

type SessionState = {
  session: Session | null;
  /** False until the stored session has been read; the root layout waits for it. */
  hydrated: boolean;
  /**
   * The one-time recovery code of a store just created (or of a recovery). The app stays on the
   * onboarding screens until the person confirms they saved it; it is never persisted.
   */
  pendingRecoveryCode: string | null;
  setSession: (session: Session, recoveryCode?: string) => void;
  acknowledgeRecoveryCode: () => void;
  /** Forgets the session (sign out, or a refresh the server refused). */
  clear: () => void;
  hydrate: () => Promise<void>;
};

export const initialSession = {
  session: null,
  hydrated: false,
  pendingRecoveryCode: null,
};

const isSession = (value: unknown): value is Session => {
  const v = value as Partial<Session> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.access_token === 'string' &&
    typeof v.refresh_token === 'string' &&
    typeof v.member === 'object' &&
    v.member !== null &&
    typeof v.store === 'object' &&
    v.store !== null
  );
};

/** Write errors must not break a sign-in: the session still works for this run. */
const persist = (session: Session | null) =>
  (session
    ? sessionStorage().set(SESSION_STORAGE_KEY, JSON.stringify(session))
    : sessionStorage().remove(SESSION_STORAGE_KEY)
  ).catch(() => undefined);

export const useSessionStore = create<SessionState>()((set, get) => ({
  ...initialSession,
  setSession: (session, recoveryCode) => {
    set((s) => ({
      session,
      hydrated: true,
      // A token rotation keeps a code that has not been acknowledged yet.
      pendingRecoveryCode: recoveryCode ?? s.pendingRecoveryCode,
    }));
    void persist(session);
  },
  acknowledgeRecoveryCode: () => set({ pendingRecoveryCode: null }),
  clear: () => {
    set({ session: null, hydrated: true, pendingRecoveryCode: null });
    void persist(null);
  },
  hydrate: async () => {
    if (get().hydrated) return;
    let stored: Session | null = null;
    try {
      const raw = await sessionStorage().get(SESSION_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      stored = isSession(parsed) ? parsed : null;
    } catch {
      stored = null;
    }
    // A sign-in that finished while the read was pending wins over the stored value.
    set((s) => ({ session: s.session ?? stored, hydrated: true }));
  },
}));

export const selectSession = (s: SessionState) => s.session;

/** Signed in and past the recovery-code screen: the app proper may show. */
export const selectSignedIn = (s: SessionState) =>
  s.session !== null && s.pendingRecoveryCode === null;

/** Enrolling is the Lead's, or a Seller the Lead granted `can_enroll`; the server answers 403 otherwise. */
export const selectCanEnroll = (s: SessionState) =>
  s.session?.member.role === 'lead' || s.session?.member.can_enroll === true;

/** Alerts, the review queue and the day close belong to the Lead; a Seller's calls would answer 403. */
export const selectIsLead = (s: SessionState) =>
  s.session?.member.role === 'lead';
