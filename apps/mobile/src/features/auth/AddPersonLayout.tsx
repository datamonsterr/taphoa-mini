import { useAuth } from '@clerk/expo';
import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAddPerson } from './addPerson';

/**
 * Layout of `/add-person`: the sign-in screens for a phone that is already signed in. Once a
 * different session is active the new person has arrived, so it hands over to the root gate,
 * which sends them to the shop or, without a store, to onboarding.
 */
export function AddPersonLayout() {
  const { sessionId } = useAuth();
  const active = sessionId ?? null;
  const from = useAddPerson((state) => state.from);
  // Stays on the redirect even after the start is moved to the new person below.
  const [handedOver, setHandedOver] = useState(false);
  if (!handedOver && from !== undefined && from !== active) setHandedOver(true);
  useEffect(() => {
    if (from !== active) useAddPerson.getState().begin(active);
  }, [from, active]);
  if (handedOver) return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
