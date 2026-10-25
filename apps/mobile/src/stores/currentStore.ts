import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { components } from '@taphoa/api-client';

export type Membership = components['schemas']['StoreMembership'];

/** A removed membership never keeps a phone pointed at an inaccessible store. */
export function resolveMembership(
  memberships: Membership[],
  storedId?: string,
): Membership | null {
  return (
    memberships.find(({ store }) => store.id === storedId) ??
    memberships[0] ??
    null
  );
}

type CurrentStoreState = {
  hydrated: boolean;
  storeIds: Record<string, string>;
  selectStore: (clerkUserId: string, storeId: string) => void;
};

/** Only preferences live here. Clerk owns credentials; React Query owns memberships. */
export const useCurrentStore = create<CurrentStoreState>()(
  persist(
    (set) => ({
      storeIds: {},
      hydrated: false,
      selectStore: (clerkUserId, storeId) =>
        set((state) => ({
          storeIds: { ...state.storeIds, [clerkUserId]: storeId },
        })),
    }),
    {
      name: 'taphoa-current-store',
      storage: createJSONStorage(() => ({
        getItem: (key) => AsyncStorage.getItem(key).catch(() => null),
        setItem: (key, value) =>
          AsyncStorage.setItem(key, value).catch(() => undefined),
        removeItem: (key) =>
          AsyncStorage.removeItem(key).catch(() => undefined),
      })),
      partialize: ({ storeIds }) => ({ storeIds }),
      merge: (persisted, current) => {
        const raw = (persisted as { storeIds?: unknown } | null)?.storeIds;
        const storeIds =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? Object.fromEntries(
                Object.entries(raw).filter(([, id]) => typeof id === 'string'),
              )
            : {};
        return { ...current, storeIds };
      },
      // Storage is a preference, so blocked/corrupt storage must not prevent sign-in.
      onRehydrateStorage: () => () =>
        useCurrentStore.setState({ hydrated: true }),
    },
  ),
);
