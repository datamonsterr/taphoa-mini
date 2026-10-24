import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'welcome' };

/** Screens for a phone without a session. */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
