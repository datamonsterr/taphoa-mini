import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { preferenceStorage } from './preferenceStorage';

type DeviceLockState = {
  hydrated: boolean;
  /** Someone signed out while others stay signed in: nobody gets in without picking a person. */
  locked: boolean;
  lock: () => void;
  unlock: () => void;
};

/**
 * Persisted so a restart cannot hand the phone to whichever session clerk-js activates on its
 * own. While locked the root gate treats the device as signed out, even with an active session.
 * Only a picked person (PIN or none, then `setActive`) or a fresh sign-in lifts it.
 */
export const useDeviceLock = create<DeviceLockState>()(
  persist(
    (set) => ({
      hydrated: false,
      locked: false,
      lock: () => set({ locked: true }),
      unlock: () => set({ locked: false }),
    }),
    {
      name: 'taphoa-device-lock',
      storage: preferenceStorage(),
      partialize: ({ locked }) => ({ locked }),
      // Anything but a stored `true` is unlocked, so bad data can never trap the phone.
      merge: (persisted, current) => ({
        ...current,
        locked: (persisted as { locked?: unknown } | null)?.locked === true,
      }),
      onRehydrateStorage: () => () =>
        useDeviceLock.setState({ hydrated: true }),
    },
  ),
);
