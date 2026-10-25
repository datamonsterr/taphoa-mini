import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'welcome' };

/** Screens for a signed-in Clerk user without a store membership. */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
