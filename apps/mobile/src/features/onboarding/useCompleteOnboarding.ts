import { useInviteIntent } from './inviteIntent';
import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '@/lib/api/keys';
import type { Me } from '@/lib/api/store';
import { useCurrentStore, type Membership } from '@/stores/currentStore';

/** The POST response is authoritative; make it visible to the gate immediately. */
export function useCompleteOnboarding() {
  const { userId } = useAuth();
  const qc = useQueryClient();
  return (membership: Membership) => {
    if (!userId) return;
    qc.setQueryData<Me>(keys.me(userId), (old) => ({
      clerk_user_id: userId,
      profile: old?.profile ?? null,
      memberships: [
        ...(old?.memberships ?? []).filter(
          ({ store }) => store.id !== membership.store.id,
        ),
        membership,
      ],
    }));
    useCurrentStore.getState().selectStore(userId, membership.store.id);
    useInviteIntent.getState().setToken('');
  };
}
