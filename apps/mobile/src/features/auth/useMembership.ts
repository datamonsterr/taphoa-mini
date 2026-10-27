import { useAuth } from '@clerk/expo';
import { useMe } from '@/lib/api/hooks';
import { resolveMembership, useCurrentStore } from '@/stores/currentStore';

/** All member permissions come from the cached /me response, never persisted credentials. */
export function useMembership() {
  const { userId } = useAuth();
  const { data } = useMe();
  const storedId = useCurrentStore((s) =>
    userId ? s.storeIds[userId] : undefined,
  );
  return resolveMembership(data?.memberships ?? [], storedId);
}
export const useIsLead = () => useMembership()?.member.role === 'lead';
export const useCanEnroll = () => {
  const member = useMembership()?.member;
  return member?.role === 'lead' || member?.can_enroll === true;
};
