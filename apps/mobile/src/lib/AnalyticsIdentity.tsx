import { useAuth, useUser } from '@clerk/expo';

import { useMembership } from '@/features/auth/useMembership';
import { useAnalyticsIdentity } from './analyticsPostHog';

/**
 * Identifies the signed-in Clerk user (`sub`) in PostHog and groups events by the selected
 * store. Renders nothing; mount it inside the auth gate so `/me` is loaded.
 */
export function AnalyticsIdentity() {
  const { userId, isSignedIn } = useAuth();
  const { user } = useUser();
  const membership = useMembership();
  useAnalyticsIdentity(
    isSignedIn && userId
      ? {
          userId,
          email: user?.primaryEmailAddress?.emailAddress ?? null,
          name: user?.fullName ?? null,
          storeId: membership?.store.id ?? null,
          storeName: membership?.store.name ?? null,
          memberId: membership?.member.id ?? null,
          role: membership?.member.role ?? null,
        }
      : null,
  );
  return null;
}

/** Mounted while nobody is in the shop: drops the PostHog identity of the previous person. */
export function AnalyticsSignedOut() {
  useAnalyticsIdentity(null);
  return null;
}
